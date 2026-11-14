// Still-image controls shared by the local browser frontend and small Node tests.
export const fitScale = (width, height, viewWidth, viewHeight) =>
  Math.min(1, viewWidth / width, viewHeight / height);
export const clampZoom = (value) => Math.max(0.05, Math.min(32, value));
export const rotateQuarter = (degrees) => (degrees + 90) % 360;

export function installImageControls(stage, image, controls) {
  const [fit, actual, minus, plus, rotate, label] = controls;
  let scale = 1, turn = 0, panX = 0, panY = 0, mode = "fit";
  const pointers = new Map();
  let pinchDistance = null;
  const size = () => ({ width: stage.clientWidth, height: stage.clientHeight });
  const fitValue = () => {
    const view = size();
    const sideways = turn % 180 !== 0;
    return fitScale(sideways ? image.naturalHeight : image.naturalWidth,
      sideways ? image.naturalWidth : image.naturalHeight, view.width, view.height);
  };
  const paint = () => {
    image.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px) rotate(${turn}deg) scale(${scale})`;
    label.textContent = `${Math.round(scale * 100)}%`;
  };
  const setFit = () => { mode = "fit"; panX = panY = 0; scale = fitValue(); paint(); };
  const setActual = () => { mode = "actual"; panX = panY = 0; scale = 1; paint(); };
  const zoom = (factor) => { mode = "custom"; scale = clampZoom(scale * factor); paint(); };
  fit.onclick = setFit;
  actual.onclick = setActual;
  minus.onclick = () => zoom(1 / 1.25);
  plus.onclick = () => zoom(1.25);
  rotate.onclick = () => { turn = rotateQuarter(turn); if (mode === "fit") scale = fitValue(); paint(); };
  const resize = new ResizeObserver(() => { if (mode === "fit" && image.naturalWidth) setFit(); });
  resize.observe(stage);
  image.onload = () => { turn = 0; setFit(); };
  stage.onwheel = (event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.2 : 1 / 1.2); };
  stage.onpointerdown = (event) => {
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };
  stage.onpointermove = (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) { panX += event.clientX - previous.x; panY += event.clientY - previous.y; paint(); }
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance) zoom(distance / pinchDistance);
      pinchDistance = distance;
    }
  };
  const release = (event) => { pointers.delete(event.pointerId); pinchDistance = null; };
  stage.onpointerup = release;
  stage.onpointercancel = release;
  stage.onkeydown = (event) => {
    if (["+", "="].includes(event.key)) zoom(1.25);
    else if (event.key === "-") zoom(1 / 1.25);
    else if (event.key.toLowerCase() === "r") rotate.click();
    else if (event.key.toLowerCase() === "f") setFit();
    else if (event.key === "1") setActual();
    else if (event.key === "ArrowLeft") panX -= 30;
    else if (event.key === "ArrowRight") panX += 30;
    else if (event.key === "ArrowUp") panY -= 30;
    else if (event.key === "ArrowDown") panY += 30;
    else return;
    paint();
    event.preventDefault();
  };
  return {
    open(url) { image.src = url; stage.focus(); },
    clear() { image.removeAttribute("src"); image.onload = () => { turn = 0; setFit(); }; },
    dispose() { resize.disconnect(); },
  };
}
