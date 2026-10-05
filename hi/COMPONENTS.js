/* Homura Interface component behavior. Plain script; no framework or globals
   beyond window.HomuraInterface. Components are initialized idempotently. */
(function (global) {
  "use strict";

  var doc = global.document;
  var initializedSegmented = typeof WeakSet === "function" ? new WeakSet() : null;
  var initializedRanges = typeof WeakSet === "function" ? new WeakSet() : null;
  var initializedPopovers = typeof WeakSet === "function" ? new WeakSet() : null;
  var popoverStates = typeof WeakMap === "function" ? new WeakMap() : null;
  var focusableSelector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex=\"-1\"])"
  ].join(",");

  function matches(element, selector) {
    return element && element.nodeType === 1 && element.matches(selector);
  }

  function descendants(root, selector) {
    var result = [];
    if (!root || !root.querySelectorAll) return result;
    if (matches(root, selector)) result.push(root);
    Array.prototype.forEach.call(root.querySelectorAll(selector), function (item) {
      result.push(item);
    });
    return result;
  }

  function emit(target, name, detail) {
    if (typeof global.CustomEvent === "function") {
      target.dispatchEvent(new global.CustomEvent(name, { bubbles: true, detail: detail }));
    }
  }

  function initSegmented(group) {
    if (initializedSegmented ? initializedSegmented.has(group) : group.dataset.hiReady === "segmented") return;
    if (initializedSegmented) initializedSegmented.add(group);
    group.dataset.hiReady = "segmented";
    var items = Array.prototype.slice.call(group.querySelectorAll(".hi-segmented__item"));
    if (!items.length) return;

    function isEnabled(item) {
      return !item.disabled && item.getAttribute("aria-disabled") !== "true";
    }

    function enabledItems() {
      return items.filter(isEnabled);
    }

    function selectedIndex() {
      var enabled = enabledItems();
      var selected = enabled.findIndex(function (item) {
        return item.getAttribute("aria-pressed") === "true";
      });
      return items.indexOf(selected < 0 ? enabled[0] : enabled[selected]);
    }

    function syncTabs(index, moveFocus, notify) {
      if (!isEnabled(items[index])) return;
      items.forEach(function (item, itemIndex) {
        var selected = itemIndex === index && isEnabled(item);
        item.setAttribute("aria-pressed", String(selected));
        item.tabIndex = selected ? 0 : -1;
      });
      if (moveFocus) items[index].focus();
      if (notify) {
        emit(group, "hi:change", {
          value: items[index].getAttribute("data-value") || items[index].textContent.trim(),
          item: items[index],
          group: group
        });
      }
    }

    var initial = enabledItems();
    if (!initial.length) {
      items.forEach(function (item) { item.tabIndex = -1; });
      return;
    }
    syncTabs(selectedIndex(), false, false);
    items.forEach(function (item, index) {
      item.addEventListener("click", function () {
        syncTabs(index, false, true);
      });
      item.addEventListener("keydown", function (event) {
        if (!isEnabled(item)) return;
        var enabled = enabledItems();
        var current = enabled.indexOf(item);
        var next = current;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % enabled.length;
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + enabled.length) % enabled.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = enabled.length - 1;
        else if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          syncTabs(index, false, true);
          return;
        } else {
          return;
        }
        event.preventDefault();
        syncTabs(items.indexOf(enabled[next]), true, true);
      });
    });
  }

  function setRangeProgress(input) {
    var min = Number(input.min || 0);
    var max = Number(input.max || 100);
    var value = Number(input.value || min);
    var progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--hi-range-progress", Math.max(0, Math.min(100, progress)) + "%");
  }

  function initRange(input) {
    if (initializedRanges ? initializedRanges.has(input) : input.dataset.hiReady === "range") return;
    if (initializedRanges) initializedRanges.add(input);
    input.dataset.hiReady = "range";
    setRangeProgress(input);
    input.addEventListener("input", function () {
      setRangeProgress(input);
      emit(input, "hi:input", { value: input.value, input: input });
    });
    input.addEventListener("change", function () {
      setRangeProgress(input);
    });
  }

  function closePopover(state, restoreFocus) {
    if (!state || !state.open) return;
    state.open = false;
    if (state.closeTimer) global.clearTimeout(state.closeTimer);
    state.panel.hidden = false;
    state.panel.setAttribute("data-hi-state", "closed");
    state.panel.inert = true;
    state.trigger.setAttribute("aria-expanded", "false");
    doc.removeEventListener("click", state.onDocumentPointerDown, true);
    doc.removeEventListener("keydown", state.onDocumentKeydown, true);
    state.closeTimer = global.setTimeout(function () {
      if (!state.open) state.panel.hidden = true;
      state.closeTimer = null;
    }, transitionDuration(state.panel) + 20);
    if (restoreFocus !== false && state.trigger.focus) state.trigger.focus();
  }

  function openPopover(state) {
    if (state.open) return;
    if (state.closeTimer) global.clearTimeout(state.closeTimer);
    state.closeTimer = null;
    state.open = true;
    state.panel.hidden = false;
    state.panel.setAttribute("data-hi-state", "open");
    state.panel.inert = false;
    state.trigger.setAttribute("aria-expanded", "true");
    doc.addEventListener("click", state.onDocumentPointerDown, true);
    doc.addEventListener("keydown", state.onDocumentKeydown, true);
    var first = state.panel.querySelector(focusableSelector);
    if (first && first.focus) first.focus();
  }

  function transitionDuration(element) {
    if (!global.getComputedStyle) return 260;
    var raw = global.getComputedStyle(element).getPropertyValue("--motion-expand-duration").trim();
    var value = parseFloat(raw);
    if (!isFinite(value)) return 260;
    return raw.indexOf("ms") >= 0 ? value : value * 1000;
  }

  function initPopover(trigger) {
    if (initializedPopovers ? initializedPopovers.has(trigger) : trigger.dataset.hiReady === "popover") return;
    var id = trigger.getAttribute("aria-controls");
    var panel = id ? doc.getElementById(id) : trigger.parentElement && trigger.parentElement.querySelector(".hi-popover");
    if (!panel || !matches(panel, ".hi-popover")) return;
    if (initializedPopovers) initializedPopovers.add(trigger);
    trigger.dataset.hiReady = "popover";
    var state = {
      trigger: trigger,
      panel: panel,
      open: false,
      closeTimer: null,
      onDocumentPointerDown: null,
      onDocumentKeydown: null
    };
    if (popoverStates) popoverStates.set(trigger, state);
    trigger.setAttribute("aria-expanded", trigger.getAttribute("aria-expanded") === "true" ? "true" : "false");
    panel.hidden = trigger.getAttribute("aria-expanded") !== "true";
    panel.setAttribute("data-hi-state", panel.hidden ? "closed" : "open");
    state.open = !panel.hidden;
    state.onDocumentPointerDown = function (event) {
      if (!state.open || state.panel.contains(event.target) || state.trigger.contains(event.target)) return;
      /* 外点关闭不抢焦点：用户点了别处，焦点该留在别处；焦点只在 Escape 和程序化关闭时归还 */
      closePopover(state, false);
    };
    state.onDocumentKeydown = function (event) {
      if (state.open && event.key === "Escape") {
        event.preventDefault();
        closePopover(state, true);
      }
    };
    trigger.addEventListener("click", function () {
      if (state.open) closePopover(state, true);
      else openPopover(state);
    });
    Array.prototype.forEach.call(panel.querySelectorAll(".hi-popover__item"), function (item) {
      item.addEventListener("click", function () {
        closePopover(state, true);
      });
    });
    var menuItems = Array.prototype.filter.call(panel.querySelectorAll(focusableSelector), function (item) {
      return item.getAttribute("aria-disabled") !== "true" && !item.disabled;
    });
    menuItems.forEach(function (item, index) {
      item.addEventListener("keydown", function (event) {
        if (!menuItems.length) return;
        var next = index;
        if (event.key === "ArrowDown") next = (index + 1) % menuItems.length;
        else if (event.key === "ArrowUp") next = (index - 1 + menuItems.length) % menuItems.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = menuItems.length - 1;
        else return;
        event.preventDefault();
        menuItems[next].focus();
      });
    });
    if (state.open) {
      doc.addEventListener("click", state.onDocumentPointerDown, true);
      doc.addEventListener("keydown", state.onDocumentKeydown, true);
    }
  }

  /* 栏上的当前项：一颗滤色片（DESIGN.md Components「当前项」，材料公式的"玻璃上的当前项"那一档）。
     染色是滤色不是涂色：feColorMatrix 吸掉背后光线里别的颜色，内容从下面经过时还看得见。
     滤色片要读到栏的玻璃，只有栏开着光学层时才成立（那时栏自己不挂 backdrop-filter，不是 backdrop root）；
     侧栏、预算用尽或不支持的浏览器里退回涂色。矩阵由 OPTICS.js 的 materialMatrix 算，它晚于本文件加载，
     所以在栏的 data-hi-optics 变化时再算一次。 */
  var currentStates = typeof WeakMap === "function" ? new WeakMap() : null;
  var lensDefs = null;
  var lensCount = 0;

  function lensDefsElement() {
    if (lensDefs) return lensDefs;
    var svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("data-hi-defs", ""); /* OPTICS.js 看到这个标记就不把这里的增删当成页面变化 */
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    lensDefs = doc.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(lensDefs);
    doc.body.appendChild(svg);
    return lensDefs;
  }

  function placeCurrent(state) {
    var item = state.bar.querySelector('.hi-button[aria-current]:not([aria-current="false"])');
    var chip = state.chip;
    if (!item) { chip.style.width = "0px"; return; }
    chip.style.left = item.offsetLeft + "px";
    chip.style.top = item.offsetTop + "px";
    chip.style.width = item.offsetWidth + "px";
    chip.style.height = item.offsetHeight + "px";
    chip.style.borderRadius = global.getComputedStyle(item).borderTopLeftRadius;
  }

  function updateCurrent(state) {
    var bar = state.bar;
    var chip = state.chip;
    var styles = global.getComputedStyle(bar);
    var own = styles.getPropertyValue("--hi-current-color").trim();
    var tItem = parseFloat(styles.getPropertyValue("--material-glass-t-item"));
    var optics = global.HomuraOptics;
    chip.style.setProperty("--hi-current-paint", own);
    if (!(optics && optics.supported && optics.supported() && optics.materialMatrix) || bar.getAttribute("data-hi-optics") !== "on" || !own || isNaN(tItem)) {
      chip.style.background = "";
      chip.style.webkitBackdropFilter = "";
      chip.style.backdropFilter = "";
      if (state.filter) { state.filter.remove(); state.filter = null; }
      return;
    }
    /* Chromium 改滤镜内部不会让引用它的 backdrop-filter 重绘，每次换新 id */
    var filter = doc.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.id = "hi-current-lens-" + (++lensCount);
    filter.setAttribute("color-interpolation-filters", "sRGB");
    filter.innerHTML = '<feColorMatrix type="matrix" values="' + optics.materialMatrix(own, tItem, "") + '"/>';
    lensDefsElement().appendChild(filter);
    if (state.filter) state.filter.remove();
    state.filter = filter;
    chip.style.background = "transparent";
    chip.style.webkitBackdropFilter = "url(#" + filter.id + ")";
    chip.style.backdropFilter = "url(#" + filter.id + ")";
  }

  function initCurrent(bar) {
    if (!currentStates || currentStates.has(bar)) return;
    var chip = doc.createElement("span");
    chip.className = "hi-toolbar__current";
    chip.setAttribute("aria-hidden", "true");
    bar.insertBefore(chip, bar.firstChild);
    var state = { bar: bar, chip: chip, filter: null };
    currentStates.set(bar, state);
    if (global.MutationObserver) {
      /* 只看栏自己的光学层开关；栏里的按钮也会被 OPTICS.js 标 data-hi-optics，那些与滤色片无关 */
      new global.MutationObserver(function () { updateCurrent(state); })
        .observe(bar, { attributes: true, attributeFilter: ["data-hi-optics", "data-hi-current"] });
      new global.MutationObserver(function () { placeCurrent(state); })
        .observe(bar, { attributes: true, subtree: true, attributeFilter: ["aria-current"] });
    }
    global.addEventListener("resize", function () { placeCurrent(state); });
    global.addEventListener("load", function () { placeCurrent(state); });
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(function () { placeCurrent(state); });
    updateCurrent(state);
    placeCurrent(state);
  }

  /* 当前项的颜色或栏的形状由页面改了之后调用：重算滤色片并重新落位。不传参数就刷新整页。 */
  function refreshCurrent(target) {
    var scope = resolveTarget(target) || doc;
    descendants(scope, ".hi-toolbar[data-hi-current]").forEach(function (bar) {
      var state = currentStates && currentStates.get(bar);
      if (!state) { initCurrent(bar); return; }
      updateCurrent(state);
      placeCurrent(state);
    });
  }

  function init(root) {
    if (!doc) return api;
    var scope = root && root.querySelectorAll ? root : doc;
    descendants(scope, ".hi-segmented").forEach(initSegmented);
    descendants(scope, ".hi-range").forEach(initRange);
    descendants(scope, "[data-hi-popover-trigger]").forEach(initPopover);
    descendants(scope, ".hi-toolbar[data-hi-current]").forEach(initCurrent);
    return api;
  }

  function resolveTarget(target) {
    if (!doc) return null;
    if (!target) return doc.documentElement;
    if (typeof target === "string") return doc.querySelector(target);
    return target.nodeType ? target : null;
  }

  function setTheme(target, theme) {
    var element = resolveTarget(target);
    if (!element || (theme !== "white-default" && theme !== "red-black")) return false;
    element.setAttribute("data-theme", theme);
    return true;
  }

  function setRed(target, redOn) {
    var element = resolveTarget(target);
    if (!element) return false;
    if (redOn) element.removeAttribute("data-red");
    else element.setAttribute("data-red", "off");
    return true;
  }

  var api = {
    init: init,
    setTheme: setTheme,
    setRed: setRed,
    refreshCurrent: refreshCurrent,
    closePopover: function (trigger) {
      var state = popoverStates && popoverStates.get(trigger);
      if (state) closePopover(state, true);
    }
  };

  global.HomuraInterface = api;
  if (doc) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", function () { init(doc); });
    else init(doc);
  }
}(typeof window !== "undefined" ? window : this));
