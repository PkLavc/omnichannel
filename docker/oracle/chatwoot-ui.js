(() => {
  'use strict';

  const STYLE_ID = 'omnichannel-panel-controls-style';
  const LEFT_ID = 'omnichannel-toggle-navigation';
  const MIDDLE_ID = 'omnichannel-toggle-conversation-list';
  const COLLAPSED_WIDTH = 160;

  const chevron = direction => `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m${direction === 'left' ? '14.5 6-6 6 6 6' : '9.5 6 6 6-6 6'}" />
    </svg>`;

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .omnichannel-panel-toggle {
        align-items: center;
        background: var(--color-n-background, #18191b);
        border: 1px solid var(--color-n-weak, #34363a);
        border-radius: 999px;
        color: var(--color-n-slate-11, #d7d9dc);
        cursor: pointer;
        display: flex;
        height: 42px;
        justify-content: center;
        padding: 0;
        position: fixed;
        top: 50%;
        transform: translate(-50%, -50%);
        transition: left 160ms ease, background-color 120ms ease;
        width: 22px;
        z-index: 60;
      }
      .omnichannel-panel-toggle:hover {
        background: var(--color-n-alpha-2, #26282b);
        border-color: var(--color-n-brand, #1f93ff);
      }
      .omnichannel-panel-toggle:focus-visible {
        outline: 2px solid var(--color-n-brand, #1f93ff);
        outline-offset: 2px;
      }
      .omnichannel-panel-toggle svg {
        fill: none;
        height: 14px;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 2;
        width: 14px;
      }
      #${MIDDLE_ID} { top: calc(50% + 50px); }
      @media (max-width: 767px) {
        .omnichannel-panel-toggle { display: none !important; }
      }
    `;
    document.head.appendChild(style);
  }

  function createButton(id) {
    let button = document.getElementById(id);
    if (button) return button;
    button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.className = 'omnichannel-panel-toggle';
    document.body.appendChild(button);
    return button;
  }

  function renderButton(button, { left, title, direction }) {
    const leftValue = `${left}px`;
    const markup = chevron(direction);
    if (button.style.left !== leftValue) button.style.left = leftValue;
    if (button.title !== title) {
      button.title = title;
      button.setAttribute('aria-label', title);
    }
    if (button.innerHTML !== markup) button.innerHTML = markup;
  }

  function findNavigation() {
    return [...document.querySelectorAll('aside')].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.height > window.innerHeight * 0.7 && rect.width >= 50 && rect.width <= 330;
    });
  }

  function findResizeHandle(navigation) {
    return navigation?.querySelector('[class*="cursor-col-resize"]') || null;
  }

  function findNativeListToggle() {
    const list = document.querySelector('.conversations-list-wrap');
    if (!list || list.getBoundingClientRect().width < 40) return null;
    const icon = list.querySelector('[class*="i-lucide-arrow-right-to-line"], [class*="i-lucide-arrow-left-to-line"]');
    const button = icon?.closest('button');
    return button ? { button, list, icon } : null;
  }

  function updateControls() {
    installStyle();
    const navigation = findNavigation();
    const resizeHandle = findResizeHandle(navigation);
    const leftButton = createButton(LEFT_ID);

    if (navigation && resizeHandle) {
      const rect = navigation.getBoundingClientRect();
      const collapsed = rect.width < COLLAPSED_WIDTH;
      leftButton.hidden = false;
      renderButton(leftButton, {
        left: Math.round(rect.right),
        title: collapsed ? 'Expandir navegação' : 'Recolher navegação',
        direction: collapsed ? 'right' : 'left',
      });
      leftButton.onclick = () => {
        resizeHandle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        window.setTimeout(updateControls, 220);
      };
    } else {
      leftButton.hidden = true;
    }

    const nativeListToggle = findNativeListToggle();
    const middleButton = createButton(MIDDLE_ID);
    if (nativeListToggle) {
      const rect = nativeListToggle.list.getBoundingClientRect();
      const isExpanded = nativeListToggle.icon.className.includes('arrow-left-to-line');
      middleButton.hidden = false;
      renderButton(middleButton, {
        left: Math.min(Math.round(rect.right), window.innerWidth - 12),
        title: isExpanded ? 'Restaurar lista de conversas' : 'Expandir lista de conversas',
        direction: isExpanded ? 'left' : 'right',
      });
      middleButton.onclick = () => {
        nativeListToggle.button.click();
        window.setTimeout(updateControls, 220);
      };
    } else {
      middleButton.hidden = true;
    }
  }

  let scheduled = false;
  const scheduleUpdate = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      updateControls();
    });
  };

  new MutationObserver(mutations => {
    const onlyExtensionChanges = mutations.every(mutation => {
      const element = mutation.target.nodeType === Node.ELEMENT_NODE
        ? mutation.target
        : mutation.target.parentElement;
      return element?.closest?.('.omnichannel-panel-toggle') || element?.id === STYLE_ID;
    });
    if (!onlyExtensionChanges) scheduleUpdate();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  window.addEventListener('resize', scheduleUpdate, { passive: true });
  scheduleUpdate();
})();
