/* Shared navigation: a burger menu with the page list in the top right corner.
   Included on every page: <script src="/nav.js"></script> before </body>. */
"use strict";
(function () {
  const PAGES = [
    ['/', 'JOURNAL'],
    ['/cards.html', 'LIVE'],
    ['/grid.html', 'GRID'],
    ['/settings.html', 'SETTINGS'],
    ['/dev.html', 'DEV'],
  ];
  const cur = location.pathname === '/index.html' ? '/' : location.pathname;

  const css = document.createElement('style');
  css.textContent =
    '#navBurger{position:fixed;top:5px;right:8px;z-index:1000;width:30px;height:26px;' +
      'background:#131418;border:1px solid #25262c;border-radius:3px;color:#6b6d75;' +
      'font-size:14px;line-height:1;cursor:pointer;padding:0}' +
    '#navBurger:hover,#navBurger.on{border-color:#56b6c2;color:#e2e2e4}' +
    '#navMenu{position:fixed;top:35px;right:8px;z-index:1000;display:none;min-width:150px;' +
      'background:#131418;border:1px solid #25262c;border-radius:4px;padding:4px 0;' +
      'box-shadow:0 6px 18px rgba(0,0,0,.5)}' +
    '#navMenu a{display:block;padding:7px 14px;color:#e2e2e4;text-decoration:none;font-size:12px;' +
      "letter-spacing:.5px;font-family:'SF Mono','JetBrains Mono','Fira Code',ui-monospace,Consolas,monospace}" +
    '#navMenu a:hover{background:rgba(86,182,194,.12);color:#fff}' +
    '#navMenu a.cur{color:#56b6c2}' +
    /* keep the header status from sliding under the burger */
    'header .bar:first-of-type{padding-right:48px}';
  document.head.appendChild(css);

  const btn = document.createElement('button');
  btn.id = 'navBurger'; btn.textContent = '☰'; btn.title = 'pages';
  const menu = document.createElement('div');
  menu.id = 'navMenu';
  menu.innerHTML = PAGES.map(([u, t]) => `<a href="${u}"${u === cur ? ' class="cur"' : ''}>${t}</a>`).join('');
  btn.onclick = e => {
    e.stopPropagation();
    const show = menu.style.display !== 'block';
    menu.style.display = show ? 'block' : 'none';
    btn.classList.toggle('on', show);
  };
  document.addEventListener('click', () => { menu.style.display = 'none'; btn.classList.remove('on'); });
  document.body.appendChild(btn);
  document.body.appendChild(menu);
})();
