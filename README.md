# taro-fetch-event-source

适用于 Taro.js 的 SSE 库

> 微信小程序暂不支持 SSE 协议, 可通过设置 wx.request 的 enableChunked 为 true 来开启分块传输, 实现 SSE 功能
> 使用方式与 Microsoft 的 [fetch-event-source](https://github.com/Azure/fetch-event-source) 库相同

```js
import { fetchEventSource } from "taro-fetch-event-source";

const controller = fetchEventSource("https://api.example.com/sse", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: "hello" }),

  async onopen(response) {
    console.log("Connection opened", response);
  },

  async onmessage(event) {
    console.log("Received message:", event.data);
    // event.id, event.event, event.data
  },

  async onclose() {
    console.log("Connection closed");
  },

  async onerror(err) {
    console.error("Error:", err);
    // 返回重试延迟时间（毫秒），返回 null 则不重试
    return 1000;
  },

  maxRetryCount: 5,
  timeout: 60000,
});

// 关闭连接
// controller.abort()
```
