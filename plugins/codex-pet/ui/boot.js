// preload 在 DOMContentLoaded 补齐 placement 标记；此处不提前导入 app。
const start = () => import('./app.js').catch((error) => {
  console.error(error);
  document.querySelector('#app').textContent = error.message;
});
if (document.readyState === 'complete') void start();
else window.addEventListener('DOMContentLoaded', start, { once: true });
