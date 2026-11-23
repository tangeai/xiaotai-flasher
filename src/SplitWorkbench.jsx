import { useLayoutEffect, useRef, useState } from 'react';

const minimum = 320;
const dividerWidth = 14;
const minimumConsole = 360;

export function SplitWorkbench({ children: [firmware, consolePanel] }) {
  const container = useRef(null);
  const drag = useRef(null);
  const [width, setWidth] = useState(0);
  const [preferred, setPreferred] = useState(null);

  useLayoutEffect(() => {
    const node = container.current;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const maximum = Math.max(minimum, width - dividerWidth - minimumConsole);
  const clamp = value => Math.min(maximum, Math.max(minimum, Math.round(value)));
  const current = clamp(preferred ?? Math.min(500, width * 0.32));

  function move(event) {
    if (drag.current?.id !== event.pointerId) return;
    const next = clamp(drag.current.start + event.clientX - drag.current.x);
    setPreferred(next);
  }

  function keyDown(event) {
    const values = { ArrowLeft: current - 16, ArrowRight: current + 16, Home: minimum, End: maximum };
    if (!Object.hasOwn(values, event.key)) return;
    event.preventDefault();
    const next = clamp(values[event.key]);
    setPreferred(next);
  }

  return (
    <div className="workbench" ref={container} style={{ '--firmware-width': current + 'px' }}>
      {firmware}
      <div className="panel-divider" role="separator" tabIndex={0}
        aria-label="调整固件面板宽度" aria-orientation="vertical" aria-controls="firmware-panel"
        aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={current}
        aria-valuetext={current + ' 像素'} title="拖动调整宽度，双击恢复默认"
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, start: current };
        }}
        onPointerMove={move}
        onPointerUp={event => {
          if (drag.current?.id !== event.pointerId) return;
          move(event);
          drag.current = null;
        }}
        onLostPointerCapture={() => { drag.current = null; }}
        onDoubleClick={() => setPreferred(null)}
        onKeyDown={keyDown}
      />
      {consolePanel}
    </div>
  );
}
