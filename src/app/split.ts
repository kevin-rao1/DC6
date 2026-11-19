// The draggable divider between the 3D view and the 2D page.

const minimumPaneWidth = 160; // px

export function makeSplit(container: HTMLElement, left: HTMLElement, divider: HTMLElement, right: HTMLElement): void {
  let dragging = false;

  // The left pane's share of the width is kept as a fraction, so the split
  // stays in proportion when the window is resized.
  function setLeftFraction(fraction: number): void {
    const width = container.clientWidth;
    let clamped = fraction;
    if (width > 0) {
      const minimumFraction = minimumPaneWidth / width;
      const maximumFraction = 1 - (minimumPaneWidth + divider.offsetWidth) / width;
      if (clamped < minimumFraction) {
        clamped = minimumFraction;
      }
      if (clamped > maximumFraction) {
        clamped = maximumFraction;
      }
    }
    left.style.flex = '0 0 ' + String(clamped * 100) + '%';
    right.style.flex = '1 1 0';
  }

  divider.addEventListener('pointerdown', function onDown(event: PointerEvent): void {
    dragging = true;
    divider.setPointerCapture(event.pointerId);
    divider.classList.add('dragging');
    event.preventDefault();
  });
  divider.addEventListener('pointermove', function onMove(event: PointerEvent): void {
    if (!dragging) {
      return;
    }
    const box = container.getBoundingClientRect();
    const fraction = (event.clientX - box.left) / box.width;
    setLeftFraction(fraction);
  });
  divider.addEventListener('pointerup', function onUp(event: PointerEvent): void {
    dragging = false;
    divider.releasePointerCapture(event.pointerId);
    divider.classList.remove('dragging');
  });
  // Keyboard: arrows move the divider, for people who do not drag.
  divider.addEventListener('keydown', function onKey(event: KeyboardEvent): void {
    const box = container.getBoundingClientRect();
    const current = left.getBoundingClientRect().width / box.width;
    if (event.key === 'ArrowLeft') {
      setLeftFraction(current - 0.02);
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      setLeftFraction(current + 0.02);
      event.preventDefault();
    }
  });
  setLeftFraction(0.5);
}
