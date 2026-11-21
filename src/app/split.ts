// The window split top and bottom: the 3D view above, the flat page below,
// both the full width, with a divider between them that can be dragged.
// Double-click the divider to put it back; drag it to the bottom to put the
// page away (dragging it up again brings it back). The page is not shown
// until a part has been placed: there is nothing to lay flat before.

// Share of the window height the 3D view takes by default.
const defaultShare = 0.5;
// Nearer the bottom than this (px), the page is put away.
const collapseDistance = 48;
// The 3D view keeps at least this much height (px).
const smallestUpper = 120;

export class Split {
  readonly upper: HTMLDivElement;
  readonly divider: HTMLDivElement;
  readonly lower: HTMLDivElement;
  private readonly root: HTMLElement;
  private share = defaultShare;
  private pageWanted = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.upper = document.createElement('div');
    this.upper.className = 'upper';
    root.appendChild(this.upper);
    this.divider = document.createElement('div');
    this.divider.className = 'divider';
    this.divider.title = 'Drag to resize; double-click to reset';
    root.appendChild(this.divider);
    this.lower = document.createElement('div');
    this.lower.className = 'lower';
    root.appendChild(this.lower);
    const self = this;
    let dragging = false;
    // Where in the divider it was grabbed, so it does not jump to the pointer.
    let grabbedAt = 0;
    this.divider.addEventListener('pointerdown', function down(event) {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      self.divider.setPointerCapture(event.pointerId);
      dragging = true;
      grabbedAt = event.clientY - self.divider.getBoundingClientRect().top;
      self.divider.classList.add('dragging');
    });
    this.divider.addEventListener('pointermove', function move(event) {
      if (!dragging) {
        return;
      }
      const height = self.root.clientHeight;
      let top = event.clientY - grabbedAt - self.root.getBoundingClientRect().top;
      top = Math.max(smallestUpper, top);
      if (top > height - collapseDistance) {
        self.share = 1;
      } else {
        self.share = top / height;
      }
      self.apply();
    });
    this.divider.addEventListener('pointerup', function up() {
      dragging = false;
      self.divider.classList.remove('dragging');
    });
    this.divider.addEventListener('dblclick', function reset() {
      self.share = defaultShare;
      self.apply();
    });
    window.addEventListener('resize', function resized() {
      self.apply();
    });
    this.apply();
  }

  // Show the page (and the divider) once there is a rocket to lay flat.
  setPageWanted(wanted: boolean): void {
    if (wanted === this.pageWanted) {
      return;
    }
    this.pageWanted = wanted;
    this.apply();
  }

  private apply(): void {
    const height = this.root.clientHeight;
    let upperHeight = height;
    if (this.pageWanted) {
      upperHeight = Math.round(height * this.share);
      if (this.share >= 1) {
        // Collapsed: the divider stays at the bottom edge to be dragged up again.
        upperHeight = height - dividerHeight;
      }
    }
    this.upper.style.height = String(upperHeight) + 'px';
    this.divider.style.display = this.pageWanted ? '' : 'none';
    this.divider.style.top = String(upperHeight) + 'px';
    this.lower.style.display = this.pageWanted && this.share < 1 ? '' : 'none';
    this.lower.style.top = String(upperHeight + dividerHeight) + 'px';
  }
}

// The divider's height (px); its line is drawn in the middle of it.
export const dividerHeight = 6;
