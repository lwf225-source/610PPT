import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// This cancellation owns only a file transfer, never an engine generation task.
export async function proxyArtifactFile({ v1, requestedPath, res }) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort(new Error("文件下载连接已关闭"));
  };
  res.once("close", onClose);
  try {
    const upstream = await v1.file(`/api/artifacts/file?path=${encodeURIComponent(requestedPath)}`, {
      signal: controller.signal
    });
    const contentType = upstream.headers.get("content-type");
    const contentLength = upstream.headers.get("content-length");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    await pipeline(Readable.fromWeb(upstream.body), res, { signal: controller.signal });
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.removeHeader("Content-Length");
    const status = Number(error.statusCode);
    res.status(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502)
      .json({ error: error.message || "文件下载失败" });
  } finally {
    res.off("close", onClose);
  }
}
