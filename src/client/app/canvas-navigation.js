// One owner for canvas navigation and explicit, native Widget interaction.
// Iframes retain their identity. Selecting a Widget never replays the selecting
// click into its document, and inactive front shells block underlying Widgets.
  function canvasNavigationTextTarget(target) {
    return Boolean(target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]'));
  }
  function canvasWidgetSelectionEnabled() {
    return !state.spacePan && (state.viewMode ? state.viewTool === "select" : state.mode === "select");
  }
  function canvasWidgetInteractive(widget) {
    return canvasWidgetSelectionEnabled() && state.interactingWidgetId === widget.id && !widget.hiddenForReplacement;
  }
  function canvasWidgetAtEvent(event) {
    // DOM hit testing respects the actual painted Widget order, including a
    // front shell covering an already-interactive Widget behind it.
    const shell = event.target?.closest?.('.canvas-widget');
    if (shell) return visibleWidgets().find(widget => widget.id === shell.dataset.widgetId) || null;
    const target = handObjectToolbarTargetAtPoint(clientPoint(event));
    return target?.kind === "widget" ? target.object : null;
  }
  function syncCanvasNavigation() {
    view.classList.toggle("select-mode", !state.viewMode && state.mode === "select");
    view.classList.toggle("widget-selection-enabled", canvasWidgetSelectionEnabled());
    view.classList.toggle("temporary-hand", state.spacePan);
    view.classList.toggle("widget-interacting", Boolean(state.interactingWidgetId));
    document.querySelector('#canvasViewHand')?.setAttribute('aria-pressed', String(state.viewTool === 'hand'));
    document.querySelector('#canvasViewSelect')?.setAttribute('aria-pressed', String(state.viewTool === 'select'));
    const exit = document.querySelector('#canvasWidgetExit');
    if (exit) exit.hidden = !state.interactingWidgetId;
    syncWidgetHostStates();
    resetCanvasCursor();
  }
  function setWidgetInteraction(widget) {
    if (widget && (!canvasWidgetSelectionEnabled() || !visibleWidgets().includes(widget))) return false;
    const next = widget?.id || null;
    if (state.interactingWidgetId === next) return true;
    const previous = state.widgets.find(item => item.id === state.interactingWidgetId);
    if (previous?.frame && document.activeElement === previous.frame) document.activeElement.blur();
    state.interactingWidgetId = next;
    syncCanvasNavigation();
    requestInteractionLayerRender();
    return true;
  }
  function setCanvasViewTool(tool) {
    if (!state.viewMode || !['hand', 'select'].includes(tool)) return;
    setWidgetInteraction(null);
    state.widgetActivationTap = null;
    state.viewTool = tool;
    syncCanvasNavigation();
  }
  function setSpacePan(enabled) {
    enabled = Boolean(enabled);
    if (state.spacePan === enabled) return;
    state.spacePan = enabled;
    syncCanvasNavigation();
  }
  function beginCanvasObjectSelection(event, point) {
    if (!point || !valid(point) || event.button !== 0) return false;
    // Existing ink lasso takes priority when a lasso is already active.
    if (state.selection) return false;
    if (state.pending) {
      const result = pendingHit(state.pending, event, state.pending.revealProgress < 1);
      const hit = typeof result === 'string' ? result : result?.hit;
      if (hit) { beginPendingGesture(event, hit, result?.itemIndex ?? null); return true; }
    }
    const widget = canvasWidgetAtEvent(event);
    const target = widget ? { kind:'widget', object:widget } : handObjectToolbarTargetAtPoint(point);
    if (state.pendingWidget && !target) {
      const result = widgetPointerHit(point, event.pointerType, true);
      if (result?.pending) return beginWidgetGesture(event, point, result);
    }
    if (!target) {
      hideHandObjectToolbar({ all:true });
      if (state.widgetEdit) acceptWidgetEdit();
      if (state.imageEdit) acceptImageEdit();
      return false;
    }
    showHandObjectToolbar(target.kind, target.object);
    if (target.kind === 'widget') {
      const hit = state.selectedWidgetId === widget.id ? widgetResizeHit(widgetBox(widget), point, event.pointerType) : null;
      return beginWidgetGesture(event, point, { widget, hit:hit || 'move', pending:false });
    }
    if (target.kind === 'image') {
      const result = imagePointerHit(point, event.pointerType, true);
      return beginImageGesture(event, point, result || { image:target.object, hit:'move' });
    }
    if (target.kind === 'animation') return beginAnimationGesture(event, point, animationPointerHit(point, event.pointerType) || { animation:target.object, hit:'move' });
    if (target.kind === 'text-box') return editTextBox(target.object);
    return false;
  }
  function canvasNavigationSurface(target) {
    if (!target || target === view || target === screen) return true;
    return Boolean(target.closest?.('.canvas-widget'));
  }
  function handleCanvasWheel(event) {
    if (!canvasNavigationSurface(event.target)) return;
    event.preventDefault();
    if (state.navigationLocked || state.drawing || state.widgetGesture || state.imageGesture || state.selectionGesture || state.trackpadGesture) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvasViewportMetrics().height : 1;
    let dx = event.deltaX * unit, dy = event.deltaY * unit;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !dx && !dy) return;
    if (event.ctrlKey || event.metaKey || state.wheelZoom) zoomCanvasAt(event.clientX, event.clientY, dy);
    else {
      if (event.shiftKey && !dx) { dx = dy; dy = 0; }
      moveCanvas(-dx, -dy);
      requestCoordinatesUpdate();
      wheelNavigating();
    }
  }
  function beginCanvasTrackpadGesture(event) {
    if (!canvasNavigationSurface(event.target)) return;
    event.preventDefault();
    if (state.navigationLocked || state.drawing) return;
    state.trackpadGesture = { scale:Number(event.scale) || 1 };
  }
  function updateCanvasTrackpadGesture(event) {
    const gesture = state.trackpadGesture;
    if (!gesture) return;
    event.preventDefault();
    const scale = Number(event.scale);
    if (!Number.isFinite(scale) || scale <= 0) return;
    zoomCanvasAt(event.clientX, event.clientY, -Math.log(scale / gesture.scale) / .002);
    gesture.scale = scale;
  }
  function endCanvasTrackpadGesture(event) {
    if (!state.trackpadGesture) return;
    event.preventDefault();
    state.trackpadGesture = null;
  }
  function zoomCanvasFromControl(direction) {
    if (state.drawing) return;
    const rect = view.getBoundingClientRect();
    setWidgetInteraction(null);
    if (state.navigationLocked) setCanvasNavigationLocked(false);
    const stops = [.03, .05, .10, .15, .25, .33, .50, .67, 1, 1.5, 2];
    const target = direction < 0
      ? stops.find(scale => scale > state.scale + .0001) || 2
      : [...stops].reverse().find(scale => scale < state.scale - .0001) || .03;
    const delta = -Math.log(target / state.scale) / .002;
    const count = Math.max(1, Math.ceil(Math.abs(delta) / 300));
    for (let i = 0; i < count; i++) zoomCanvasAt(rect.x + rect.width / 2, rect.y + rect.height / 2, delta / count);
  }
  function fitCanvasContents() {
    if (state.drawing) return;
    setWidgetInteraction(null);
    if (state.navigationLocked) setCanvasNavigationLocked(false);
    let bounds = visibleInkBounds({ x:0, y:0, w:SIZE, h:SIZE });
    for (const next of [imageBounds(), textBoxBounds(), animationBounds(), widgetBounds()]) bounds = unionLocalBounds(bounds, next);
    if (!bounds) bounds = { x:SIZE / 2 - 1500, y:SIZE / 2 - 1000, w:3000, h:2000 };
    const metrics = canvasViewportMetrics(), padding = 64;
    const previousPanX = state.panX, previousPanY = state.panY, previousScale = state.scale;
    state.scale = Math.max(.03, Math.min(2, (metrics.width - padding * 2) / Math.max(1,bounds.w), (metrics.height - padding * 2) / Math.max(1,bounds.h)));
    state.panX = (metrics.width - bounds.w * state.scale) / 2 - bounds.x * state.scale;
    state.panY = (metrics.height - bounds.h * state.scale) / 2 - bounds.y * state.scale;
    requestCanvasNavigationPreview(previousPanX, previousPanY, previousScale);
    requestCoordinatesUpdate();
  }
  document.querySelector('#canvasViewHand')?.addEventListener('click', () => setCanvasViewTool('hand'));
  document.querySelector('#canvasViewSelect')?.addEventListener('click', () => setCanvasViewTool('select'));
  document.querySelector('#canvasWidgetExit')?.addEventListener('click', () => {
    setWidgetInteraction(null);
    (state.viewMode ? document.querySelector('#canvasViewSelect') : document.querySelector('#lassoToolBtn'))?.focus({ preventScroll:true });
  });
  document.querySelector('#canvasZoomOut')?.addEventListener('click', () => zoomCanvasFromControl(1));
  document.querySelector('#canvasZoomIn')?.addEventListener('click', () => zoomCanvasFromControl(-1));
  document.querySelector('#canvasFitContents')?.addEventListener('click', fitCanvasContents);
  document.querySelector('#canvasZoomReset')?.addEventListener('click', () => {
    const rect = view.getBoundingClientRect();
    setWidgetInteraction(null);
    if (state.navigationLocked) setCanvasNavigationLocked(false);
    // Use bounded steps to reach 100% without changing the zoom anchor.
    const delta = Math.log(state.scale) / .002;
    const count = Math.max(1, Math.ceil(Math.abs(delta) / 300));
    for (let i = 0; i < count; i++) zoomCanvasAt(rect.x + rect.width / 2, rect.y + rect.height / 2, delta / count);
  });
  const wheelZoomSetting = document.querySelector('#settingsWheelZoom');
  if (wheelZoomSetting) {
    wheelZoomSetting.setAttribute('aria-checked', String(state.wheelZoom));
    wheelZoomSetting.classList.toggle('on', state.wheelZoom);
    wheelZoomSetting.addEventListener('click', () => {
      state.wheelZoom = !state.wheelZoom;
      wheelZoomSetting.setAttribute('aria-checked', String(state.wheelZoom));
      wheelZoomSetting.classList.toggle('on', state.wheelZoom);
      localStorage.setItem('penecho-wheel-zoom', String(state.wheelZoom));
    });
  }
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || canvasNavigationTextTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector('dialog[open],.settings-panel.open,.configuration-layer:not([hidden])')) return;
    if (event.code === 'Space' && !event.target?.closest?.('button') && !state.drawing) {
      event.preventDefault();
      setSpacePan(true);
    } else if (event.key === 'Escape' && state.interactingWidgetId) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setWidgetInteraction(null);
    } else if (!event.repeat && !state.drawing && !state.widgetGesture && !state.selectionGesture && ['h','v','p'].includes(event.key.toLowerCase())) {
      if (state.viewMode && event.key.toLowerCase() === 'p') return;
      event.preventDefault();
      if (state.viewMode) setCanvasViewTool(event.key.toLowerCase() === 'h' ? 'hand' : 'select');
      else selectCanvasToolMode({ h:'hand', v:'select', p:'pen' }[event.key.toLowerCase()], { showHint:true });
    }
  }, true);
  window.addEventListener('keyup', (event) => { if (event.code === 'Space') setSpacePan(false); }, true);
  window.addEventListener('blur', () => { setSpacePan(false); state.trackpadGesture = null; state.widgetActivationTap = null; });
