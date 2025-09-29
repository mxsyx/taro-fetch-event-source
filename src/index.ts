import Taro from "@tarojs/taro";

export const EventStreamContentType = "text/event-stream";

const DefaultRetryInterval = 1000;
const LastEventId = "last-event-id";

function uint8ArrayToUtf8(uint8Array: Uint8Array) {
  let result = "";
  let i = 0;
  const len = uint8Array.length;

  while (i < len) {
    const byte = uint8Array[i];

    // 单字节字符 (0xxxxxxx)
    if (byte < 0x80) {
      result += String.fromCharCode(byte);
      i++;
    }
    // 双字节字符 (110xxxxx 10xxxxxx)
    else if (byte >= 0xc2 && byte <= 0xdf) {
      if (i + 1 >= len) break; // 防止越界
      const byte2 = uint8Array[i + 1];
      if ((byte2 & 0xc0) !== 0x80) break; // 检查是否为 10xxxxxx
      const codepoint = ((byte & 0x1f) << 6) | (byte2 & 0x3f);
      result += String.fromCharCode(codepoint);
      i += 2;
    }
    // 三字节字符 (1110xxxx 10xxxxxx 10xxxxxx)
    else if (byte >= 0xe0 && byte <= 0xef) {
      if (i + 2 >= len) break;
      const byte2 = uint8Array[i + 1];
      const byte3 = uint8Array[i + 2];
      if ((byte2 & 0xc0) !== 0x80 || (byte3 & 0xc0) !== 0x80) break;
      const codepoint =
        ((byte & 0x0f) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f);
      // UTF-16 编码（JavaScript 内部使用 UTF-16）
      if (codepoint < 0xd800 || codepoint >= 0xe000) {
        result += String.fromCharCode(codepoint);
      } else {
        // 代理对范围，但三字节不会产生代理对，直接输出
        result += String.fromCharCode(codepoint);
      }
      i += 3;
    }
    // 四字节字符 (11110xxx 10xxxxxx 10xxxxxx 10xxxxxx) —— 用于 emoji 等
    else if (byte >= 0xf0 && byte <= 0xf4) {
      if (i + 3 >= len) break;
      const byte2 = uint8Array[i + 1];
      const byte3 = uint8Array[i + 2];
      const byte4 = uint8Array[i + 3];
      if (
        (byte2 & 0xc0) !== 0x80 ||
        (byte3 & 0xc0) !== 0x80 ||
        (byte4 & 0xc0) !== 0x80
      )
        break;

      let codepoint =
        ((byte & 0x07) << 18) |
        ((byte2 & 0x3f) << 12) |
        ((byte3 & 0x3f) << 6) |
        (byte4 & 0x3f);

      // 超出 BMP（Basic Multilingual Plane）的字符需转为 UTF-16 代理对
      if (codepoint > 0xffff) {
        codepoint -= 0x10000;
        const highSurrogate = 0xd800 + (codepoint >> 10);
        const lowSurrogate = 0xdc00 + (codepoint & 0x3ff);
        result += String.fromCharCode(highSurrogate, lowSurrogate);
      } else {
        result += String.fromCharCode(codepoint);
      }
      i += 4;
    }
    // 无效字节，跳过（或可替换为 ）
    else {
      i++;
    }
  }

  return result;
}

export interface FetchEventSourceInit {
  /** 请求头 */
  headers?: Record<string, string>;

  /** 请求方法，默认 GET */
  method?: string;

  /** 请求体 */
  body?: string | Record<string, any>;

  /**
   * 连接成功时的回调
   */
  onopen?: (
    response: Taro.request.SuccessCallbackResult
  ) => void | Promise<void>;

  /**
   * 接收到消息时的回调
   */
  onmessage?: (event: EventSourceMessage) => void | Promise<void>;

  /**
   * 连接关闭时的回调
   */
  onclose?: () => void | Promise<void>;

  /**
   * 发生错误时的回调
   * 返回错误重试的延迟时间（毫秒），返回 undefined 则不重试
   */
  onerror?: (err: any) => number | null | undefined | void;

  /**
   * 是否在页面关闭时自动关闭连接，默认 true
   */
  openWhenHidden?: boolean;

  /**
   * 最大重试次数，默认无限制
   */
  maxRetryCount?: number;

  /**
   * 请求超时时间（毫秒），默认 300000 (5分钟)
   */
  timeout?: number;
}

export interface EventSourceMessage {
  id?: string;
  event?: string;
  data: string;
}

class FatalError extends Error {}

export function fetchEventSource(
  url: string,
  {
    headers: inputHeaders = {},
    method = "GET",
    body,
    onopen,
    onmessage,
    onclose,
    onerror,
    openWhenHidden = false,
    maxRetryCount,
    timeout = 300000,
  }: FetchEventSourceInit
): { abort: () => void } {
  let requestTask: Taro.RequestTask<any> | null = null;
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let isAborted = false;

  // 用于存储当前的 event-id
  let lastEventId = "";

  // 用于拼接不完整的消息
  let buffer = "";

  const abort = () => {
    isAborted = true;
    if (requestTask) {
      try {
        requestTask.abort();
      } catch (e) {
        console.error("abort error:", e);
      }
      requestTask = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    // 清空 buffer
    buffer = "";
  };

  const connect = async () => {
    if (isAborted) return;

    const headers = { ...inputHeaders };
    if (lastEventId) {
      headers[LastEventId] = lastEventId;
    }

    try {
      requestTask = Taro.request({
        url,
        method: method as any,
        header: headers,
        data: body,
        enableChunked: true,
        responseType: "text",
        timeout,
        success: async () => {
          if (isAborted) return;

          // 重置重试计数
          retryCount = 0;

          // 清空 requestTask
          requestTask = null;

          // 调用 onclose
          try {
            await onclose?.();
          } catch (err) {
            console.error("onclose error:", err);
          }

          // 检查是否需要重连（只有在未手动关闭且配置允许的情况下）
          if (!isAborted && !openWhenHidden) {
            scheduleRetry(DefaultRetryInterval);
          }
        },
        fail: async (err) => {
          if (isAborted) return;

          // 清空 requestTask
          requestTask = null;

          // 调用 onerror 获取重试延迟
          let retryDelay: number | null | void | undefined;
          try {
            retryDelay = onerror?.(err);
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (err) {
            retryDelay = null;
          }

          if (retryDelay != null) {
            scheduleRetry(retryDelay);
          }
        },
      });

      requestTask.onHeadersReceived(async (res) => {
        if (isAborted) return;

        try {
          await onopen?.(res as any);
        } catch (err) {
          console.error("onopen error:", err);
          throw new FatalError(String(err));
        }
      });

      requestTask.onChunkReceived((res) => {
        if (isAborted) return;
        handleChunk(res);
      });
    } catch (err) {
      if (isAborted) return;

      if (err instanceof FatalError) {
        abort();
        throw err;
      }

      // 调用 onerror 获取重试延迟
      let retryDelay: number | null | void | undefined;
      try {
        retryDelay = onerror?.(err);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (err) {
        retryDelay = null;
      }

      if (retryDelay != null) {
        scheduleRetry(retryDelay);
      }
    }
  };

  const scheduleRetry = (delayMs: number) => {
    if (isAborted) return;

    // 检查最大重试次数
    if (maxRetryCount !== undefined && retryCount >= maxRetryCount) {
      console.warn("Max retry count reached");
      return;
    }

    retryCount++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delayMs);
  };

  const handleChunk = (res: { data: ArrayBuffer }) => {
    try {
      const arrayBuffer = res.data;
      const uint8Array = new Uint8Array(arrayBuffer);

      // 将 ArrayBuffer 转换为字符串
      let text = "";
      text = uint8ArrayToUtf8(uint8Array);

      // 将新数据添加到 buffer
      buffer += text;

      // 按行分割，保留最后不完整的行
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // 保留最后一个（可能不完整的）行

      let message: Partial<EventSourceMessage> = {};

      for (const line of lines) {
        // 空行表示消息结束
        if (line === "\r" || line === "") {
          if (message.data !== undefined) {
            // 发送消息
            onmessage?.({
              id: message.id,
              event: message.event,
              data: message.data,
            } as EventSourceMessage);

            // 更新 lastEventId
            if (message.id) {
              lastEventId = message.id;
            }
          }
          message = {};
          continue;
        }

        // 注释行
        if (line.startsWith(":")) {
          continue;
        }

        // 解析字段
        const colonIndex = line.indexOf(":");
        const field = colonIndex > 0 ? line.substring(0, colonIndex) : line;
        let value = colonIndex > 0 ? line.substring(colonIndex + 1) : "";

        // 去掉开头的空格
        if (value.startsWith(" ")) {
          value = value.substring(1);
        }

        switch (field) {
          case "event":
            message.event = value;
            break;
          case "data":
            message.data = (message.data || "") + value + "\n";
            break;
          case "id":
            message.id = value;
            break;
          case "retry":
            // 可以在这里处理 retry 字段
            break;
        }
      }
    } catch (err) {
      console.error("handleChunk error:", err);
      onerror?.(err);
    }
  };

  // 开始连接
  connect();

  return { abort };
}
