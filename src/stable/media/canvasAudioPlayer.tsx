import type * as ReactTypes from 'react';
import { createAudioWaveform, type AudioWaveform, type AudioRange } from './audioWaveform';

type Runtime = Pick<
  typeof ReactTypes,
  'createElement' | 'Fragment' | 'useState' | 'useRef' | 'useEffect' | 'useCallback'
>;
type Icon = ReactTypes.ComponentType<{
  size?: number;
  className?: string;
  fill?: string;
  strokeWidth?: number;
}>;
interface AudioNode {
  id: string;
  projectId?: string;
  resultUrl?: string;
  status?: string;
  type?: string;
  uploadPending?: boolean;
}
interface Props {
  data: AudioNode;
  selected?: boolean;
  onAudioTrim?(id: string, start: number, end: number): unknown | Promise<unknown>;
}
interface Components {
  PlayIcon: Icon;
  PauseIcon: Icon;
  TrimIcon: Icon;
  ConfirmIcon: Icon;
  Spinner: Icon;
  AudioIcon: Icon;
  Tooltip: ReactTypes.ComponentType<{
    text: string;
    position?: string;
    children: ReactTypes.ReactNode;
  }>;
  createWaveform?: typeof createAudioWaveform;
}

export function CanvasAudioPlayer(
  React: Runtime,
  { data, selected, onAudioTrim }: Props,
  {
    Spinner,
    AudioIcon,
    ConfirmIcon,
    createWaveform = createAudioWaveform,
  }: Components,
) {
  const root = React.useRef<HTMLDivElement>(null);
  const container = React.useRef<HTMLDivElement>(null);
  const player = React.useRef<AudioWaveform | null>(null);
  const owner = React.useRef<object | null>(null);
  const trimPending = React.useRef(false);

  const [ready, setReady] = React.useState(false);
  const [range, setRange] = React.useState<AudioRange | null>(null);
  const [error, setError] = React.useState('');
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [rangeChanged, setRangeChanged] = React.useState(false);

  React.useEffect(() => {
    const token = {};
    owner.current = token;
    setReady(false);
    setRange(null);
    setError('');
    setLoadFailed(false);
    setSaving(false);
    setRangeChanged(false);
    trimPending.current = false;
    let instance: AudioWaveform | undefined;
    let failed = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const active = () => owner.current === token && !failed;
    const fail = () => {
      if (!active()) return;
      failed = true;
      clearTimeout(timeout);
      setReady(false);
      setLoadFailed(true);
      setError('音频加载失败，请重试');
      instance?.destroy();
      player.current = null;
    };
    if (data.resultUrl && container.current) {
      timeout = setTimeout(fail, 30000);
      try {
        instance = createWaveform(container.current, data.resultUrl, {
          ready() {
            if (active()) {
              clearTimeout(timeout);
              setReady(true);
            }
          },
          time() {},
          playing() {},
          range(value) {
            if (active()) {
              setRange(value);
              setRangeChanged(true);
            }
          },
          error: fail,
        });
        if (failed) instance.destroy();
        else player.current = instance;
      } catch {
        fail();
      }
    }
    return () => {
      owner.current = null;
      clearTimeout(timeout);
      instance?.destroy();
      player.current = null;
    };
  }, [data.id, data.projectId, data.resultUrl, createWaveform]);

  React.useEffect(() => {
    const visibility = () => {
      if (document.hidden) player.current?.pause();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);

  const trim = async (event: ReactTypes.SyntheticEvent) => {
    event.stopPropagation();
    if (!range || !onAudioTrim || trimPending.current || !(range.end > range.start)) return;
    const token = owner.current;
    trimPending.current = true;
    setSaving(true);
    setError('');
    player.current?.pause();
    try {
      const result = await onAudioTrim(data.id, range.start, range.end);
      if (owner.current !== token) return;
      if (result === false) setError('裁切未完成，请重试');
      else setRangeChanged(false);
    } catch {
      if (owner.current === token) setError('裁切失败，请重试');
    } finally {
      if (owner.current === token) {
        trimPending.current = false;
        setSaving(false);
      }
    }
  };

  const loading = data.status === 'loading';
  const canTrim =
    !loading && !data.uploadPending && !!data.resultUrl && !/^(blob|data):/i.test(data.resultUrl);

  // 右键菜单：保存音频
  const onContextMenu = (event: ReactTypes.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!data.resultUrl) return;
    const a = document.createElement('a');
    a.href = data.resultUrl;
    a.download = `audio-${data.id}.mp3`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div
      ref={root}
      data-fisherai-audio-player={data.id}
      className="w-full h-full rounded-lg overflow-hidden relative bg-black"
      onContextMenu={onContextMenu}
    >
      {data.resultUrl ? (
        <>
          <div ref={container} className="absolute inset-0" aria-label="音频波形" />
          {/* 裁切确认按钮 */}
          {ready && rangeChanged && canTrim && onAudioTrim && (
            <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5">
              <button
                aria-label="应用裁切"
                onClick={trim}
                disabled={saving || !range || !(range.end > range.start)}
                className={`flex items-center gap-1 px-2.5 h-7 rounded-md text-xs font-medium transition-all shadow-lg ${
                  saving || !range || !(range.end > range.start)
                    ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed'
                    : 'bg-emerald-600 text-white hover:bg-emerald-500 active:scale-95'
                }`}
              >
                {saving ? (
                  <Spinner size={12} className="animate-spin" />
                ) : (
                  <ConfirmIcon size={12} strokeWidth={3} />
                )}
                {saving ? '裁切中' : '应用裁切'}
              </button>
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="absolute bottom-0 left-0 right-0 text-xs px-3 py-1.5 bg-red-900/90 text-red-100 z-20 flex items-center justify-between gap-2"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span className="truncate">{error}</span>
              <button
                aria-label="关闭错误提示"
                onClick={(event) => {
                  event.stopPropagation();
                  setError('');
                }}
                className="shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-red-700 text-red-200"
              >
                ×
              </button>
            </div>
          )}
          {(!ready && !loadFailed) && (
            <div
              className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center"
            >
              <Spinner size={24} className="animate-spin text-zinc-500" />
            </div>
          )}
        </>
      ) : (
        <div
          className={`relative w-full h-full bg-black flex flex-col items-center justify-center gap-2 rounded-lg ${
            selected ? 'border border-dashed border-zinc-600' : ''
          }`}
        >
          {loading ? (
            <Spinner size={24} className="animate-spin text-zinc-500" />
          ) : (
            <>
              <AudioIcon size={32} className="text-zinc-600" />
              {(data.type === 'Upload Audio' || data.type === 'upload-audio') && (
                <span className="text-[10px] font-medium text-zinc-500">
                  选择音频文件
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
