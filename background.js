// background.js (MV3 service worker)

chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (msg?.type !== "DEVTOOLS_TRUSTED_CLICK") return;

  const tabId = sender?.tab?.id;
  if (!tabId) return;

  try {
    // 附加 debugger（DevTools 協議）
    await chrome.debugger.attach({ tabId }, "1.3");

    // 告訴 DevTools 我們要對頁面發滑鼠事件
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.round(msg.x),
      y: Math.round(msg.y),
      button: "left",
      clickCount: 1
    });

    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.round(msg.x),
      y: Math.round(msg.y),
      button: "left",
      clickCount: 1
    });

    sendResponse({ ok: true });
  } catch (e) {
    console.warn("[YT Auto Skip Ads] DevTools click failed:", e);
    sendResponse({ ok: false, error: String(e) });
  } finally {
    // 一定要拆掉，不然整頁會被 debugger 接管
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  }

  // 回應是 async，要 return true
  return true;
});
