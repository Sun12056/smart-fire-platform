/* ============================================================
   粒子思考球 / Particle orb
   参考 libraries.dev/orbs「ThinkingOrb」的球形形态与状态语义，
   呈现方式改为 bencho.dev「Particles / Dot swarm / Magnetic dots
   (Hover)」的粒子点云：球面点云缓慢自转 + 呼吸；鼠标悬停时
   光标附近粒子被推开、亮度与自转提升，离开后弹性回归。
   无状态文字、无外部依赖、尊重 prefers-reduced-motion。
   ============================================================ */
(function () {
  'use strict';

  var REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function token(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function mount(host, canvas, options) {
    options = options || {};
    var ctx = canvas.getContext('2d');
    if (!ctx) return { setConnecting: function () {} };

    var COUNT = options.count || 220;
    var RADIUS_RATIO = options.radiusRatio || 0.335;
    var FILL = options.fillRatio || 0.34;   // 内部粒子占比，让球体不空
    var GOLDEN = Math.PI * (3 - Math.sqrt(5));
    var pts = [];
    for (var i = 0; i < COUNT; i++) {
      var y = 1 - (i / (COUNT - 1)) * 2;
      var r = Math.sqrt(Math.max(0, 1 - y * y));
      var th = GOLDEN * i;
      // 约 2/3 在球面、1/3 收缩到球体内部，形成实心点云
      var shell = Math.random() < FILL ? (0.18 + Math.random() * 0.68) : 1;
      pts.push({
        x: Math.cos(th) * r * shell, y: y * shell, z: Math.sin(th) * r * shell,
        dx: 0, dy: 0, phase: Math.random() * Math.PI * 2,
        size: 0.65 + Math.random() * 0.9
      });
    }

    var W = 1, H = 1, dpr = 1;
    var angle = 0.5, clock = 0, hover = 0, hoverTarget = 0, focus = 0;
    var mx = -9999, my = -9999, connecting = false, raf = 0;
    var tilt = -0.34;
    var cAccent, cAccent2, cWarn, cPale;

    function readTokens() {
      cAccent = token('--accent', '#E44C3D');
      cAccent2 = token('--accent-2', '#FF7A2F');
      cWarn = token('--warn', '#F5A524');
      cPale = '#ffe6bd';
    }
    readTokens();

    function measure() {
      var rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(1, Math.round((rect.width || host.clientWidth || 96) * dpr));
      H = Math.max(1, Math.round((rect.height || host.clientHeight || 96) * dpr));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W; canvas.height = H;
      }
    }

    function render() {
      ctx.clearRect(0, 0, W, H);
      var cx = W / 2, cy = H / 2;
      var breath = 1 + 0.055 * Math.sin(clock * 1.7);
      var R = Math.min(W, H) * RADIUS_RATIO * breath * (connecting ? 0.9 : 1);
      var scale = Math.min(W, H) / 96;   // 大尺寸下粒子与推力同比放大
      var ca = Math.cos(angle), sa = Math.sin(angle);
      var ct = Math.cos(tilt), st = Math.sin(tilt);
      var influence = Math.min(W, H) * 0.46;
      var strength = Math.max(hover, focus);
      var glow = connecting ? 0.35 : strength * 0.4;
      var drawn = [];

      for (var k = 0; k < pts.length; k++) {
        var p = pts[k];
        // 绕 Y 轴自转，再绕 X 轴倾斜，得到球面点云
        var x = p.x * ca + p.z * sa;
        var z = -p.x * sa + p.z * ca;
        var y2 = p.y * ct - z * st;
        var z2 = p.y * st + z * ct;
        var persp = 1 / (1 - z2 * 0.22);
        var bx = cx + x * R * persp;
        var by = cy + y2 * R * persp;

        // 鼠标 / 键盘聚焦产生的斥力：光标附近粒子被推开
        var tx = 0, ty = 0;
        if (strength > 0.01 && influence > 0) {
          var hx = mx >= 0 ? mx * dpr : cx;
          var hy = my >= 0 ? my * dpr : cy - R * 0.3;
          var dx = bx - hx, dy = by - hy;
          var dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (dist < influence) {
            var f = (1 - dist / influence) * strength;
            var push = f * 16 * dpr * Math.min(scale, 6);
            var jitter = Math.sin(clock * 7 + p.phase) * f * 2.2 * dpr * Math.min(scale, 6);
            tx = (dx / dist) * push + jitter;
            ty = (dy / dist) * push + jitter;
          }
        }
        // 弹性跟随，离开后自然回弹
        p.dx += (tx - p.dx) * 0.14;
        p.dy += (ty - p.dy) * 0.14;

        drawn.push({
          x: bx + p.dx, y: by + p.dy,
          depth: (z2 + 1) / 2,
          size: p.size * (0.8 + 0.7 * ((z2 + 1) / 2)) * (1 + strength * 0.35),
          spark: p.phase
        });
      }

      // 远的先画，近的后画，形成球体层次
      drawn.sort(function (a, b) { return a.depth - b.depth; });
      for (var j = 0; j < drawn.length; j++) {
        var d = drawn[j];
        var dep = d.depth;
        ctx.globalAlpha = Math.min(1, 0.16 + 0.78 * dep + glow);
        ctx.fillStyle = dep > 0.88 ? cPale : dep > 0.72 ? cWarn : dep > 0.42 ? cAccent2 : cAccent;
        var rad = d.size * dpr * Math.min(scale, 5) * (connecting ? 1.25 : 1);
        ctx.beginPath();
        ctx.arc(d.x, d.y, rad, 0, Math.PI * 2);
        ctx.fill();
      }

      // 悬停 / 连接时的中心辉光，让粒子球有体积感
      if (strength > 0.01 || connecting) {
        var g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.05);
        g.addColorStop(0, 'rgba(229,76,61,' + (0.06 + 0.1 * Math.max(strength, connecting ? 1 : 0)) + ')');
        g.addColorStop(1, 'rgba(229,76,61,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, R * 1.05, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function tick() {
      var boost = connecting ? 3 : 1;
      angle += 0.0042 * boost + Math.max(hover, focus) * 0.009;
      clock += 0.016;
      hover += (hoverTarget - hover) * 0.08;
      render();
      raf = requestAnimationFrame(tick);
    }

    if (!REDUCE) {
      measure();
      host.addEventListener('pointermove', function (e) {
        var r = host.getBoundingClientRect();
        mx = e.clientX - r.left;
        my = e.clientY - r.top;
        hoverTarget = 1;
      });
      host.addEventListener('pointerenter', function () { hoverTarget = 1; });
      host.addEventListener('pointerleave', function () {
        hoverTarget = 0; mx = -9999; my = -9999;
      });
      host.addEventListener('focus', function () { focus = 1; });
      host.addEventListener('blur', function () { focus = 0; });
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(function () { measure(); }).observe(host);
      } else {
        window.addEventListener('resize', measure);
      }
      raf = requestAnimationFrame(tick);
    } else {
      measure();
      render();
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(function () { measure(); render(); }).observe(host);
      } else {
        window.addEventListener('resize', function () { measure(); render(); });
      }
    }

    return {
      setConnecting: function (v) { connecting = !!v; },
      refresh: readTokens,
      destroy: function () { cancelAnimationFrame(raf); }
    };
  }

  window.FireOrb = { mount: mount, reduced: REDUCE };
})();
