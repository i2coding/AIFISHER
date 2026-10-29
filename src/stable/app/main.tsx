import { preventFileDropNavigation } from '../../shared/fileDrop';
import '../main';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasRoot } from './canvasRuntime';
import { installLogCapture } from '../diagnostics/logCapture';
import { logBus } from '../diagnostics/logBus';
import './canvas.css';
import '../appearance/appearance.css';

const element = document.getElementById('root');
if (!element) throw new Error('画布根容器不存在。');
preventFileDropNavigation();
// 尽早接管 fetch / 未捕获异常 / console，界面一启动就能记录问题。
installLogCapture();
logBus.info('界面已启动', 'app');
if (window.aifisherDesktop?.integratedTitleBar) document.documentElement.dataset.afIntegratedTitlebar = 'true';
createRoot(element).render(
  <React.StrictMode>
    <CanvasRoot />
  </React.StrictMode>,
);
