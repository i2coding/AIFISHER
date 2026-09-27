// serveCanvas.js — 在生产模式下服务前端构建产物（SPA）。
//
// 挂载位置在 server/index.js 的 /api、/library、/diagnostics 404 兜底之后，
// 因此这里只需要服务静态资源并为 SPA 路由回退到 index.html。

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const BACKEND_PREFIXES = ['/api', '/library', '/diagnostics'];

function isBackendPath(pathname) {
  return (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/library/') ||
    pathname === '/diagnostics' ||
    pathname.startsWith('/diagnostics/')
  );
}

export function serveCanvas(app, distDir) {
  const root = path.resolve(String(distDir || ''));
  const indexFile = path.join(root, 'index.html');
  if (!fs.existsSync(indexFile)) {
    console.warn(`[serveCanvas] 未找到前端构建产物 index.html: ${root}`);
    return;
  }

  app.use(
    express.static(root, {
      index: false,
      maxAge: 0,
      etag: true,
    }),
  );

  app.get(/.*/, (request, response) => {
    const pathname = request.path || '/';
    if (BACKEND_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) || isBackendPath(pathname)) {
      response.status(404).json({ error: 'Not Found', code: 'NOT_FOUND' });
      return;
    }
    response.sendFile(indexFile);
  });
}
