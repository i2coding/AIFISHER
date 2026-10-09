import type * as React from 'react';
import type { CanvasNode } from '../nodes/canvasNodeOperations';
import { interruptedGenerationPatch } from '../generation/generationRecovery';
import { inspectImage } from './generationMediaMetadata';

interface Binding {
  projectId: string;
  getNodes(): CanvasNode[];
  isActive(): boolean;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  select(ids: string[]): void;
}
const runtime = {
  inspect: inspectImage,
  id: (): string => crypto.randomUUID(),
  now: Date.now,
};

async function readUpscaleTargetSize(): Promise<number> {
  try {
    const res = await fetch('/api/preferences');
    const body = await res.json();
    const raw = body?.values?.['runninghub.upscale.targetSize'];
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 256 && parsed <= 8192 ? parsed : 2048;
  } catch {
    return 2048;
  }
}

async function callUpscaleWebApp(input: {
  projectId: string;
  sourceUrl: string;
  targetSize: number;
}): Promise<string> {
  const res = await fetch('/api/upscale-webapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.url) {
    throw new Error(body?.error || '高清放大失败。');
  }
  return body.url as string;
}

export function createCanvasImageUpscale(binding: Binding, api = runtime) {
  let disposed = false;
  const activeSources = new Set<string>();
  const active = () => !disposed && binding.isActive();
  return {
    dispose() {
      disposed = true;
    },
    async start(sourceId: string) {
      if (!active() || activeSources.has(sourceId)) return;
      const source = binding.getNodes().find((node) => node.id === sourceId);
      if (
        !source ||
        !['Image', 'Upload Image'].includes(source.type) ||
        !source.resultUrl ||
        source.uploadPending ||
        source.status === 'loading' ||
        !binding.projectId
      )
        return;
      if (
        binding
          .getNodes()
          .some(
            (node) =>
              node.upscaleSourceId === sourceId &&
              (node.status === 'loading' ||
                node.generationDiagnosticCode === 'GENERATION_OBSERVATION_INTERRUPTED'),
          )
      ) {
        throw new Error('此图片已有放大任务正在处理或核对，请先查看原结果卡。');
      }
      activeSources.add(sourceId);
      const id = api.id(),
        attempt = api.id();
      const node: CanvasNode = {
        id,
        type: 'Image',
        projectId: binding.projectId,
        x: source.x + (Number(source.width) || 365) + 56,
        y: source.y,
        width: Number(source.width) || 365,
        title: 'AI 高清放大 · 自定义应用',
        prompt: '高清放大（自定义 WebApp）',
        imageModel: 'SeedVR2 放大 · 自定义',
        imageMode: 'image-to-image',
        resolution: 'Auto',
        aspectRatio: source.resultAspectRatio || source.aspectRatio || '16:9',
        mediaOperation: 'seedvr2-upscale',
        upscaleSourceId: sourceId,
        upscaleSourceUrl: source.resultUrl,
        status: 'loading',
        generationAttemptId: attempt,
        generationStartTime: api.now(),
      };
      const patch = (value: Partial<CanvasNode>) => {
        if (!active()) return;
        binding.setNodes((nodes) =>
          nodes.map((current) =>
            current.id === id && current.generationAttemptId === attempt
              ? { ...current, ...value }
              : current,
          ),
        );
      };
      binding.setNodes((nodes) => [...nodes, node]);
      binding.select([id]);
      try {
        const targetSize = await readUpscaleTargetSize();
        const url = await callUpscaleWebApp({
          projectId: binding.projectId,
          sourceUrl: String(source.resultUrl),
          targetSize,
        });
        if (!url)
          throw Object.assign(new Error('正在核对原放大任务。'), {
            code: 'GENERATION_OBSERVATION_INTERRUPTED',
          });
        if (!active()) return;
        const metadata = await api.inspect(url).catch(() => ({}));
        patch({
          ...metadata,
          resultUrl: url,
          resultUrls: [url],
          status: 'success',
          generationAttemptId: undefined,
          generationStartTime: undefined,
          generationDiagnosticCode: undefined,
        });
      } catch (error) {
        const interrupted = interruptedGenerationPatch(
          error as { code?: string; name?: string },
          attempt,
        );
        patch({
          status: 'error',
          errorMessage: error instanceof Error ? error.message : '放大失败，请检查 RH 连接。',
          generationStartTime: undefined,
          generationAttemptId: undefined,
          ...interrupted,
        });
      } finally {
        activeSources.delete(sourceId);
      }
    },
  };
}

export function useCanvasImageUpscale(
  React: Pick<typeof import('react'), 'useRef' | 'useEffect' | 'useLayoutEffect' | 'useCallback'>,
  options: Omit<Binding, 'projectId' | 'isActive'> & { projectId?: string; enabled: boolean },
) {
  const currentRef = React.useRef(options);
  React.useLayoutEffect(() => {
    currentRef.current = options;
  });
  const sessionRef = React.useRef<ReturnType<typeof createCanvasImageUpscale> | null>(null);
  React.useEffect(() => {
    if (!options.projectId || !options.enabled) return;
    const projectId = options.projectId;
    const owned = createCanvasImageUpscale({
      projectId,
      getNodes: () => currentRef.current.getNodes(),
      isActive: () => currentRef.current.enabled && currentRef.current.projectId === projectId,
      setNodes: (value) => currentRef.current.setNodes(value),
      select: (ids) => currentRef.current.select(ids),
    });
    sessionRef.current = owned;
    return () => {
      owned.dispose();
      if (sessionRef.current === owned) sessionRef.current = null;
    };
  }, [options.projectId, options.enabled]);
  return React.useCallback((id: string) => {
    void sessionRef.current
      ?.start(id)
      .catch((error: unknown) =>
        window.alert(error instanceof Error ? error.message : '无法开始高清放大。'),
      );
  }, []);
}
