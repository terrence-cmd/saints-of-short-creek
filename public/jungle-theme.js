/**
 * Saints of Short Creek — Jungle UI treatment
 * Add this file to the site and load it with:
 *   <script src="/jungle-theme.js" defer></script>
 *
 * The decoration is isolated from the application: it is aria-hidden,
 * pointer-events:none, and uses a very high stacking layer only at the edges.
 */
(function () {
  "use strict";

  if (window.__shortCreekJungleLoaded) return;
  window.__shortCreekJungleLoaded = true;

  const style = document.createElement("style");
  style.id = "short-creek-jungle-styles";
  style.textContent = `
    :root {
      --jungle-deep: #082d22;
      --jungle-leaf: #176b3a;
      --jungle-bright: #43a047;
      --jungle-lime: #8bc34a;
      --jungle-gold: #f4c95d;
      --jungle-shadow: rgba(3, 24, 17, .48);
    }

    body.jungle-enveloped {
      min-height: 100vh;
      background-color: #dce8d3;
      background-image:
        linear-gradient(180deg, rgba(239,247,225,.76) 0%, rgba(206,226,194,.62) 39%, rgba(72,129,75,.20) 100%),
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMax slice'%3E%3Cpath fill='%2394aa91' fill-opacity='.42' d='M0 510L170 303l91 103 175-232 150 211 116-142 173 208 129-160 161 188 140-165 295 270v317H0z'/%3E%3Cpath fill='%236c9271' fill-opacity='.42' d='M0 612l205-197 115 113 169-197 137 177 124-101 176 147 145-135 145 133 111-83 273 196v235H0z'/%3E%3Cpath fill='%233f744d' fill-opacity='.50' d='M0 702c52-71 90-59 138-13 42-97 105-102 159-18 57-104 129-95 177 1 48-80 116-93 177 0 54-98 136-96 183 0 51-82 118-87 171 2 54-105 136-94 184 6 51-89 128-83 173 7 43-73 101-69 138 4v209H0z'/%3E%3Cg fill='%231d5935' fill-opacity='.45'%3E%3Cpath d='M90 900V663h13v237zM58 706l40-105 41 105-40-19z'/%3E%3Cpath d='M1430 900V618h15v282zM1387 672l51-132 53 132-53-24z'/%3E%3Cpath d='M1265 900V712h11v188zM1238 750l33-87 35 87-35-16z'/%3E%3Cpath d='M284 900V746h10v154zM258 777l31-77 32 77-32-14z'/%3E%3C/g%3E%3C/svg%3E"),
        radial-gradient(circle at 14% 10%, rgba(67,160,71,.16), transparent 32rem),
        radial-gradient(circle at 88% 82%, rgba(23,107,58,.16), transparent 34rem),
        linear-gradient(180deg, #e9f1dc 0%, #bfd4b1 55%, #779b72 100%);
      background-size: cover, cover, auto, auto, cover;
      background-position: center, center bottom, left top, right bottom, center;
      background-repeat: no-repeat;
      background-attachment: fixed;
    }

    body.jungle-enveloped::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      background:
        radial-gradient(ellipse at 50% 30%, rgba(255,255,225,.34), transparent 35%),
        linear-gradient(90deg, rgba(8,45,34,.13), transparent 16% 84%, rgba(8,45,34,.13));
    }

    .jungle-frame, .jungle-canopy, .jungle-floor, .jungle-vine,
    .jungle-creature, .jungle-light, .jungle-animal-ribbon {
      position: fixed;
      pointer-events: none !important;
      user-select: none;
      z-index: 2147483000;
    }

    .jungle-canopy {
      inset: 0 0 auto 0;
      height: clamp(50px, 9vw, 112px);
      filter: drop-shadow(0 10px 12px var(--jungle-shadow));
      background:
        radial-gradient(ellipse at 4% 0%, #0d4a2b 0 42%, transparent 44%),
        radial-gradient(ellipse at 14% 0%, #247a3e 0 38%, transparent 40%),
        radial-gradient(ellipse at 27% -10%, #145d32 0 45%, transparent 47%),
        radial-gradient(ellipse at 42% -18%, #338647 0 42%, transparent 44%),
        radial-gradient(ellipse at 58% -18%, #155a32 0 43%, transparent 45%),
        radial-gradient(ellipse at 74% -8%, #2a7c41 0 43%, transparent 45%),
        radial-gradient(ellipse at 88% 0%, #12532f 0 40%, transparent 42%),
        radial-gradient(ellipse at 100% 0%, #2b8243 0 43%, transparent 45%);
      transform-origin: top center;
      animation: jungle-breathe 7s ease-in-out infinite;
    }

    .jungle-frame {
      top: 0;
      bottom: 0;
      width: clamp(28px, 5vw, 72px);
      opacity: .96;
      filter: drop-shadow(0 0 14px var(--jungle-shadow));
    }
    .jungle-frame.left { left: 0; }
    .jungle-frame.right { right: 0; transform: scaleX(-1); }

    .jungle-leaf {
      position: absolute;
      left: -16%;
      width: 120%;
      aspect-ratio: 1 / 1.7;
      border-radius: 100% 0 100% 0;
      transform: rotate(var(--r, 42deg));
      transform-origin: 0 100%;
      background: linear-gradient(135deg, var(--c, #2e8b45), #0e4a2d 78%);
      box-shadow: inset -7px -5px 13px rgba(0,0,0,.2);
      animation: jungle-sway var(--d, 6s) ease-in-out infinite alternate;
    }
    .jungle-leaf::after {
      content: "";
      position: absolute;
      inset: 48% 8% auto 8%;
      height: 2px;
      background: rgba(220,255,205,.32);
      transform: rotate(-43deg);
      transform-origin: center;
    }

    .jungle-vine {
      top: -15px;
      width: 5px;
      height: clamp(120px, 23vh, 270px);
      border-radius: 50%;
      background: linear-gradient(90deg, #174b29, #4d8b46, #123d25);
      box-shadow: 2px 0 5px rgba(0,0,0,.28);
      transform-origin: top;
      animation: jungle-vine-sway 8s ease-in-out infinite alternate;
    }
    .jungle-vine::after {
      content: "";
      position: absolute;
      bottom: -18px;
      left: -8px;
      width: 22px;
      height: 30px;
      border-radius: 100% 0 100% 0;
      background: #388e4b;
      transform: rotate(22deg);
    }
    .jungle-vine.v1 { left: 8%; }
    .jungle-vine.v2 { right: 12%; height: clamp(85px, 17vh, 190px); animation-delay: -3s; }

    .jungle-floor {
      left: 0;
      right: 0;
      bottom: -18px;
      height: clamp(42px, 8vw, 96px);
      opacity: .92;
      filter: drop-shadow(0 -7px 10px rgba(3,24,17,.25));
      background:
        radial-gradient(ellipse at 4% 100%, #1b6b39 0 42%, transparent 44%),
        radial-gradient(ellipse at 16% 110%, #398b48 0 43%, transparent 45%),
        radial-gradient(ellipse at 31% 110%, #155a32 0 43%, transparent 45%),
        radial-gradient(ellipse at 49% 112%, #2b7b41 0 46%, transparent 48%),
        radial-gradient(ellipse at 68% 110%, #155a32 0 44%, transparent 46%),
        radial-gradient(ellipse at 84% 108%, #398b48 0 42%, transparent 44%),
        radial-gradient(ellipse at 98% 100%, #1b6b39 0 43%, transparent 45%);
    }

    .jungle-animal-ribbon {
      left: 50%;
      bottom: clamp(12px, 2vw, 28px);
      width: min(880px, calc(100vw - 80px));
      height: clamp(66px, 10vw, 122px);
      transform: translateX(-50%);
      display: flex;
      align-items: flex-end;
      justify-content: space-around;
      padding: 0 clamp(8px, 2vw, 24px);
      box-sizing: border-box;
      font-family: "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
      line-height: 1;
      filter: drop-shadow(0 7px 5px rgba(0,0,0,.28));
    }

    .jungle-animal-ribbon::before {
      content: "";
      position: absolute;
      z-index: -1;
      left: 2%;
      right: 2%;
      bottom: 3px;
      height: 34%;
      border-radius: 50% 50% 18% 18%;
      background: linear-gradient(180deg, #398b48, #155a32 72%);
      box-shadow: 0 6px 0 #0d4528;
    }

    .jungle-ribbon-item {
      display: inline-block;
      position: relative;
      transform-origin: center bottom;
      font-size: clamp(30px, 5vw, 62px);
      animation: jungle-animal-bob var(--speed, 6s) ease-in-out infinite;
      animation-delay: var(--delay, 0s);
    }
    .jungle-ribbon-item.tree {
      z-index: -1;
      font-size: clamp(47px, 8vw, 96px);
      margin-inline: clamp(-18px, -2vw, -5px);
      filter: saturate(.9) brightness(.9);
      animation-name: jungle-tree-sway;
    }
    .jungle-ribbon-item.giraffe { font-size: clamp(48px, 7vw, 88px); }
    .jungle-ribbon-item.elephant { font-size: clamp(36px, 5.8vw, 72px); }
    .jungle-ribbon-item.lion { font-size: clamp(34px, 5vw, 64px); }
    .jungle-ribbon-item.zebra { font-size: clamp(32px, 4.8vw, 60px); }

    @keyframes jungle-animal-bob {
      0%, 100% { transform: translateY(0) rotate(-1deg); }
      50% { transform: translateY(-3px) rotate(1deg); }
    }
    @keyframes jungle-tree-sway {
      0%, 100% { transform: rotate(-1.5deg); }
      50% { transform: rotate(1.5deg); }
    }

    .jungle-creature {
      font-family: "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
      line-height: 1;
      filter: drop-shadow(0 5px 5px rgba(0,0,0,.28));
      transform-origin: center bottom;
    }
    .jungle-creature.parrot {
      top: clamp(44px, 7vw, 84px);
      right: clamp(24px, 5vw, 72px);
      font-size: clamp(30px, 4vw, 55px);
      animation: jungle-perch 5s ease-in-out infinite;
    }
    .jungle-creature.monkey {
      bottom: clamp(26px, 5vw, 65px);
      left: clamp(25px, 5vw, 78px);
      font-size: clamp(32px, 4.5vw, 62px);
      animation: jungle-peek 7s ease-in-out infinite;
    }
    .jungle-creature.butterfly {
      top: 28%;
      left: 7%;
      font-size: clamp(18px, 2.2vw, 29px);
      animation: jungle-flutter 11s ease-in-out infinite;
    }

    .jungle-light {
      inset: 0;
      z-index: 2147482999;
      background:
        linear-gradient(112deg, transparent 0 16%, rgba(255,245,180,.07) 24%, transparent 34%),
        linear-gradient(70deg, transparent 0 68%, rgba(255,245,180,.055) 76%, transparent 84%);
      mix-blend-mode: screen;
    }

    @keyframes jungle-sway { to { transform: rotate(calc(var(--r, 42deg) + 8deg)) scale(1.035); } }
    @keyframes jungle-vine-sway { from { transform: rotate(-2deg); } to { transform: rotate(3deg); } }
    @keyframes jungle-breathe { 50% { transform: scaleY(1.035); } }
    @keyframes jungle-perch { 0%,100% { transform: rotate(-3deg); } 50% { transform: translateY(4px) rotate(4deg); } }
    @keyframes jungle-peek { 0%,18%,100% { transform: translateY(24%); } 35%,72% { transform: translateY(0) rotate(-3deg); } }
    @keyframes jungle-flutter {
      0%,100% { transform: translate(0,0) rotate(-8deg); }
      32% { transform: translate(55px,-34px) rotate(12deg); }
      68% { transform: translate(25px,45px) rotate(-12deg); }
    }

    @media (max-width: 720px) {
      .jungle-frame { width: 31px; opacity: .82; }
      .jungle-canopy { height: 52px; opacity: .9; }
      .jungle-creature.butterfly, .jungle-light { display: none; }
      .jungle-creature.parrot { right: 24px; }
      .jungle-creature.monkey { left: 20px; }
      .jungle-animal-ribbon {
        width: calc(100vw - 42px);
        bottom: 10px;
        height: 68px;
        overflow: hidden;
      }
      .jungle-ribbon-item:nth-child(2),
      .jungle-ribbon-item:nth-child(8) { display: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      .jungle-enveloped *, .jungle-enveloped *::before, .jungle-enveloped *::after {
        animation-duration: .001ms !important;
        animation-iteration-count: 1 !important;
      }
    }

    @media print {
      .jungle-frame, .jungle-canopy, .jungle-floor, .jungle-vine,
      .jungle-creature, .jungle-light, .jungle-animal-ribbon { display: none !important; }
    }
  `;

  const layer = document.createElement("div");
  layer.id = "short-creek-jungle";
  layer.setAttribute("aria-hidden", "true");

  const leaves = [
    ["3%", "48deg", "#2e8b45", "6.2s"], ["15%", "28deg", "#176b3a", "7.3s"],
    ["29%", "58deg", "#43a047", "5.7s"], ["43%", "34deg", "#1f773c", "8.1s"],
    ["58%", "55deg", "#388e4b", "6.8s"], ["72%", "25deg", "#206f39", "7.7s"],
    ["86%", "52deg", "#43a047", "5.9s"]
  ].map(([top, rotation, color, duration]) =>
    `<i class="jungle-leaf" style="top:${top};--r:${rotation};--c:${color};--d:${duration}"></i>`
  ).join("");

  layer.innerHTML = `
    <div class="jungle-light"></div>
    <div class="jungle-canopy"></div>
    <div class="jungle-frame left">${leaves}</div>
    <div class="jungle-frame right">${leaves}</div>
    <div class="jungle-vine v1"></div>
    <div class="jungle-vine v2"></div>
    <div class="jungle-creature parrot">🦜</div>
    <div class="jungle-creature monkey">🐒</div>
    <div class="jungle-creature butterfly">🦋</div>
    <div class="jungle-animal-ribbon">
      <span class="jungle-ribbon-item tree" style="--speed:8s">🌴</span>
      <span class="jungle-ribbon-item zebra" style="--delay:-3s">🦓</span>
      <span class="jungle-ribbon-item giraffe" style="--delay:-1s;--speed:7s">🦒</span>
      <span class="jungle-ribbon-item tree" style="--delay:-4s;--speed:9s">🌳</span>
      <span class="jungle-ribbon-item lion" style="--delay:-2s">🦁</span>
      <span class="jungle-ribbon-item elephant" style="--delay:-5s;--speed:7.5s">🐘</span>
      <span class="jungle-ribbon-item tree" style="--delay:-2s;--speed:8.5s">🌴</span>
      <span class="jungle-ribbon-item zebra" style="--delay:-4s;--speed:6.5s">🦓</span>
      <span class="jungle-ribbon-item giraffe" style="--delay:-3s;--speed:7.8s">🦒</span>
      <span class="jungle-ribbon-item tree" style="--delay:-6s;--speed:9.5s">🌳</span>
    </div>
    <div class="jungle-floor"></div>
  `;

  function mount() {
    if (!document.head || !document.body) return requestAnimationFrame(mount);
    const originalBackground = getComputedStyle(document.body).backgroundColor;
    document.documentElement.style.setProperty("--jungle-original-background", originalBackground);
    document.head.appendChild(style);
    document.body.appendChild(layer);
    document.body.classList.add("jungle-enveloped");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
