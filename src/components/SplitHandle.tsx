import { useCallback, useEffect, useRef } from "react";

interface SplitHandleProps {
  /** vertical：竖直分隔条，拖拽调整宽度（x 轴）；horizontal：水平分隔条，调整高度（y 轴） */
  direction: "vertical" | "horizontal";
  /** 相对上一次事件的像素增量，符号语义由父级解释 */
  onDelta: (delta: number) => void;
  /** 双击恢复默认尺寸 */
  onReset?: () => void;
  label: string;
  value?: number;
}

export function SplitHandle({ direction, onDelta, onReset, label, value }: SplitHandleProps) {
  const lastPosition = useRef(0);
  const dragging = useRef(false);

  const release = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove(`split-dragging-${direction}`);
  }, [direction]);
  useEffect(() => () => document.body.classList.remove(`split-dragging-${direction}`), [direction]);

  return (
    <div
      className={`split-handle split-handle-${direction}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={direction === "vertical" ? "vertical" : "horizontal"}
      aria-valuenow={value}
      aria-valuemin={value === undefined ? undefined : 0}
      aria-valuemax={value === undefined ? undefined : 100}
      onKeyDown={(event) => {
        const decrease = direction === "vertical" ? "ArrowLeft" : "ArrowUp";
        const increase = direction === "vertical" ? "ArrowRight" : "ArrowDown";
        if (event.key === decrease || event.key === increase) {
          event.preventDefault();
          onDelta((event.key === decrease ? -1 : 1) * (event.shiftKey ? 32 : 8));
        } else if (event.key === "Home" && onReset) {
          event.preventDefault();
          onReset();
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragging.current = true;
        lastPosition.current = direction === "vertical" ? event.clientX : event.clientY;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add(`split-dragging-${direction}`);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const position = direction === "vertical" ? event.clientX : event.clientY;
        const delta = position - lastPosition.current;
        if (delta !== 0) {
          lastPosition.current = position;
          const element = event.currentTarget;
          const rect = element.getBoundingClientRect();
          const scale = direction === "vertical" ? rect.width / element.offsetWidth : rect.height / element.offsetHeight;
          onDelta(delta / (scale || 1));
        }
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onDoubleClick={() => onReset?.()}
    />
  );
}
