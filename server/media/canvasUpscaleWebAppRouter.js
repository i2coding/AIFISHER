import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  RunningHubWorkflowClient,
  RunningHubWorkflowClientError,
} from '../workflowRuntime/runningHubWorkflowClient.js';
import {
  readRunningHubAccessConfig,
  RUNNINGHUB_ACCESS_DEFAULTS,
} from '../workflowRuntime/runningHubAccessConfig.js';

// 画布 HD 高清放大直调 RunningHub WebApp。
// 目标应用：SeedVR2 放大（webAppId 2108076047095201793，海外站）。
// 字段：nodeId=14/image（输入图，RunningHub 上传后的文件名），nodeId=18/value（目标边长，整数）。
const UPSCALE_WEBAPP_ID = '2108076047095201793';
const UPSCALE_BASE_URL = 'https://www.runninghub.ai';
const UPSCALE_IMAGE_NODE_ID = '14';
const UPSCALE_IMAGE_FIELD = 'image';
const UPSCALE_SIZE_NODE_ID = '18';
const UPSCALE_SIZE_FIELD = 'value';
const DEFAULT_TARGET_SIZE = 2048;
const MIN_POLL_DELAY_MS = 100;

const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}$/;

function jsonError(response, status, message, code = 'UPSCALE_WEBAPP_ERROR') {
  response.status(status).json({ error: message, code });
}

function safeProjectId(value) {
  const normalized = String(value || '').trim();
  return SAFE_NAME.test(normalized) ? normalized : null;
}

function safeImageFileName(value) {
  const normalized = path.basename(String(value || '').trim());
  return SAFE_NAME.test(normalized) ? normalized : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCanvasUpscaleWebAppRouter({ libraryDirectory, privateDirectory }) {
  if (!libraryDirectory) throw new Error('canvasUpscaleWebAppRouter requires libraryDirectory');
  const router = express.Router();
  const json = express.json({ limit: '64kb' });

  router.post('/upscale-webapp', json, async (request, response) => {
    try {
      const projectId = safeProjectId(request.body?.projectId);
      const sourceUrl = String(request.body?.sourceUrl || '');
      const sourceName = safeImageFileName(sourceUrl.split('/').pop() || '');
      const targetSizeRaw = Number(request.body?.targetSize);
      const targetSize = Number.isInteger(targetSizeRaw) && targetSizeRaw >= 256 && targetSizeRaw <= 8192
        ? targetSizeRaw
        : DEFAULT_TARGET_SIZE;
      if (!projectId || !sourceName) {
        return jsonError(response, 400, '缺少项目或源图参数。');
      }
      const apiKey = process.env.RUNNINGHUB_GLOBAL_API_KEY;
      if (!apiKey) {
        return jsonError(response, 409, 'RunningHub 海外站 API Key 未配置，请先在云端工作流设置里保存。', 'RUNNINGHUB_CREDENTIAL_NOT_CONFIGURED');
      }

      const imagesDir = path.join(libraryDirectory, 'media', projectId, 'images');
      const sourcePath = path.join(imagesDir, sourceName);
      const sourceBuffer = await readFile(sourcePath);
      if (!sourceBuffer.length) throw new Error('源图读取为空。');

      const client = new RunningHubWorkflowClient({
        baseUrl: UPSCALE_BASE_URL,
        apiKey,
        timeoutMs: 30_000,
      });

      // 1) 上传源图到 RunningHub
      const uploaded = await client.uploadBuffer(sourceBuffer, sourceName, {
        apiProtocol: 'legacy-webapp-v1',
      });
      console.log('[upscale-webapp] uploaded fileName =', uploaded.fileName, 'fileType =', uploaded.fileType);
      // 2) 提交 WebApp 任务
      const { taskId } = await client.createWebAppTask({
        webAppId: UPSCALE_WEBAPP_ID,
        nodeInfoList: [
          {
            nodeId: UPSCALE_IMAGE_NODE_ID,
            fieldName: UPSCALE_IMAGE_FIELD,
            fieldValue: uploaded.fileName,
          },
          {
            nodeId: UPSCALE_SIZE_NODE_ID,
            fieldName: UPSCALE_SIZE_FIELD,
            fieldValue: String(targetSize),
          },
        ],
        instanceType: 'default',
        apiProtocol: 'legacy-webapp-v1',
      });
      console.log('[upscale-webapp] taskId =', taskId, 'targetSize =', targetSize);

      // 3) 轮询——与现有 WebApp 节点一致：全局访问配置 + 抖动 + 连续失败重试
      const access = await readRunningHubAccessConfig(privateDirectory);
      const deadline = Date.now() + access.totalTimeoutMs;
      let consecutiveFailures = 0;
      let result;
      for (;;) {
        try {
          const polled = await client.getWebAppTaskOutputs(taskId, {
            apiProtocol: 'legacy-webapp-v1',
          });
          console.log('[upscale-webapp] poll =', polled.state, polled.status, 'outputs =', Array.isArray(polled.outputs) ? polled.outputs.length : polled.outputs, polled.reason || '');
          if (polled.state === 'success') {
            result = polled;
            break;
          }
          if (polled.state === 'failed') {
            return jsonError(response, 502, polled.reason || '高清放大任务失败。');
          }
          consecutiveFailures = 0;
        } catch (error) {
          console.log('[upscale-webapp] poll error =', error?.code, error?.message, 'retryable =', error?.retryable);
          if (!(error instanceof RunningHubWorkflowClientError)) throw error;
          if (!error.retryable) throw error;
          // 网络不可达类错误持续重试到总超时，不因偶发抖动放弃；
          // 其余可重试错误（限流/5xx）按全局重试上限计数。
          if (error.code !== 'RUNNINGHUB_UNAVAILABLE') {
            consecutiveFailures += 1;
            if (consecutiveFailures > access.retryMaxAttempts) throw error;
          }
        }
        if (Date.now() > deadline) {
          return jsonError(response, 504, '高清放大超时，请稍后重试。');
        }
        const jitter = (Math.random() * 2 - 1) * access.jitterMs;
        const delay = Math.max(
          MIN_POLL_DELAY_MS,
          Math.round(access.baseIntervalMs + jitter),
        );
        await sleep(delay);
      }
      const fileUrl = result.outputs?.[0]?.fileUrl || result.outputs?.[0]?.url;
      console.log('[upscale-webapp] outputs[0] =', JSON.stringify(result.outputs?.[0]));
      if (!fileUrl) return jsonError(response, 502, '高清放大未返回结果图。');

      // 4) 下载结果图到本地素材库
      const remoteResponse = await client.openOutput({ url: fileUrl });
      console.log('[upscale-webapp] openOutput status =', remoteResponse.status, remoteResponse.headers?.get('content-type'));
      const chunks = [];
      for await (const chunk of remoteResponse.body) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      console.log('[upscale-webapp] downloaded bytes =', buffer.length);
      if (!buffer.length) throw new Error('结果图下载为空。');

      await mkdir(imagesDir, { recursive: true });
      const ext = path.extname(sourceName).toLowerCase() || '.png';
      const outName = `${randomUUID()}${ext}`;
      await writeFile(path.join(imagesDir, outName), buffer);
      console.log('[upscale-webapp] saved ->', outName);

      response.json({
        url: `/library/media/${encodeURIComponent(projectId)}/images/${encodeURIComponent(outName)}`,
      });
    } catch (error) {
      const status = Number(error?.status) || 500;
      jsonError(response, status, error instanceof Error ? error.message : '高清放大失败。');
    }
  });

  return router;
}
