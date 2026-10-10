// 设置窗口仍由宿主提供原生拖动；宠物窗口自行处理指针和跨屏移动。
// 模块在 DOMContentLoaded 前执行，早于 preload 安装拖动区域。
if (new URLSearchParams(location.search).get('surface') === 'settings') {
  document.documentElement.removeAttribute('data-pi-plugin-no-drag');
}

// preload 在 DOMContentLoaded 补齐 placement 标记；此处不提前导入 app。
const start = () => import('./app.js').catch((error) => {
  console.error(error);
  document.querySelector('#app').textContent = error.message;
});
if (document.readyState === 'complete') void start();
else window.addEventListener('DOMContentLoaded', start, { once: true });
