import Taro from "@tarojs/taro";

export const EventStreamContentType = "text/event-stream";

const DefaultRetryInterval = 1000;
const LastEventId = "last-event-id";

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
      const decoder = new TextDecoder("utf-8");
      text = decoder.decode(uint8Array);

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
