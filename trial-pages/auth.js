/* ============================================================
   auth.js — 登录 / 注册页共用交互
   bencho：Particles（背景火星）、Tilt card（3D 倾斜）、Magnetic（磁吸）、
           Eye tracker（眼睛）、Sweep/Toast（CSS 动效配合）、Form error（抖动）
   beui：入场弹簧曲线、ResizeObserver 思路（折叠测高沿用同一 API）
   boardui：身份验证卡片结构、第三方登录
   ============================================================ */
(function () {
  'use strict';
  var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.documentElement;

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast toast--' + type;
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
  }

  /* 眼睛显示/隐藏 + 磁吸 */
  function bindEye() {
    var pwd = document.getElementById('password');
    var toggle = document.getElementById('pwToggle');
    if (!pwd || !toggle) return;
    toggle.addEventListener('click', function () {
      var visible = pwd.type === 'text';
      pwd.type = visible ? 'password' : 'text';
      toggle.classList.toggle('is-visible', !visible);
      toggle.setAttribute('aria-pressed', String(!visible));
      toggle.setAttribute('aria-label', visible ? '显示密码' : '隐藏密码');
      toggle.classList.remove('pop'); void toggle.offsetWidth; toggle.classList.add('pop');
    });
    if (!reduceMotion) {
      toggle.addEventListener('pointermove', function (e) {
        var r = toggle.getBoundingClientRect();
        var mx = (e.clientX - r.left - r.width / 2) * .5;
        var my = (e.clientY - r.top - r.height / 2) * .5;
        toggle.style.transform = 'translate(' + mx + 'px, calc(-50% + ' + my + 'px))';
      });
      toggle.addEventListener('pointerleave', function () { toggle.style.transform = 'translateY(-50%)'; });
    }
  }

  /* 忘记密码 dialog（View Transitions 降级回退） */
  function bindDialog() {
    var link = document.getElementById('forgot');
    var dialog = document.getElementById('resetDialog');
    if (!link || !dialog) return;
    var email = document.getElementById('resetEmail');
    link.addEventListener('click', function (e) {
      e.preventDefault();
      if (document.startViewTransition) document.startViewTransition(function () { dialog.showModal(); });
      else dialog.showModal();
    });
    document.getElementById('resetCancel').addEventListener('click', function () { dialog.close(); });
    document.getElementById('resetSend').addEventListener('click', function () {
      dialog.close();
      toast('请联系管理员重置密码（本平台不提供自助重置）', 'success');
      email.value = '';
    });
  }

  /* 提交：接入 /api/auth/login（AUTH-8），保留原抖动 / connecting / Toast 视觉 */
  function bindForm(opts) {
    var form = document.getElementById(opts.formId);
    if (!form) return;
    var btn = document.getElementById('submitBtn');

    function fail(msg) {
      btn.disabled = false;
      btn.textContent = '登录';
      if (opts.orb) opts.orb.setConnecting(false);
      toast(msg, 'error');
      var field = form.querySelector('.field');
      if (field) { field.classList.remove('shake'); void field.offsetWidth; field.classList.add('shake'); }
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.checkValidity()) {
        var firstInvalid = form.querySelector(':invalid');
        if (firstInvalid) {
          firstInvalid.focus();
          var field = firstInvalid.closest('.field');
          if (field) { field.classList.remove('shake'); void field.offsetWidth; field.classList.add('shake'); }
        }
        form.reportValidity();
        toast('请检查标红的字段', 'error');
        return;
      }

      var username = document.getElementById('username');
      var pwd = document.getElementById('password');
      btn.disabled = true;
      btn.innerHTML = '<span class="orb" aria-hidden="true"></span> 登录中…';
      if (opts.orb) opts.orb.setConnecting(true);

      fetch(opts.loginUrl || '/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: username.value.trim(), password: pwd.value })
      }).then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch (err) { body = null; }
          if (res.ok) {
            toast(opts.successText || '登录成功', 'success');
            var next = safeNext();
            setTimeout(function () { location.replace(next); }, 320);
            return;
          }
          if (res.status === 401) { fail('用户名或密码不正确'); return; }
          if (res.status === 429) { fail('尝试次数过多，请稍后再试'); return; }
          if (res.status === 403) { fail('请求来源校验失败，请刷新页面后重试'); return; }
          if (res.status === 503) { fail('认证服务暂不可用，请稍后重试'); return; }
          if (res.status === 400) { fail('输入不合法，请检查用户名与密码'); return; }
          fail('登录失败（' + res.status + '）');
        });
      }).catch(function () {
        fail('网络异常，请检查连接后重试');
      });
    });

    /* 仅允许站内相对路径，防开放重定向；支持 /#/route 形式的 SPA 路径 */
    function safeNext() {
      var raw = new URLSearchParams(location.search).get('next');
      if (!raw) return '/';
      if (raw.charAt(0) !== '/') return '/';
      if (raw.charAt(1) === '/' || raw.charAt(1) === '\\') return '/';
      if (raw === '/login' || raw.indexOf('/login?') === 0 || raw.indexOf('/login/') === 0) return '/';
      return raw;
    }
  }

  /* 密码一致性（注册页） */
  function bindConfirm(confirmId) {
    var pwd = document.getElementById('password');
    var confirm = document.getElementById(confirmId);
    if (!pwd || !confirm) return;
    function check() {
      if (confirm.value && confirm.value !== pwd.value) confirm.setCustomValidity('两次输入的密码不一致。');
      else confirm.setCustomValidity('');
    }
    pwd.addEventListener('input', check);
    confirm.addEventListener('input', check);
  }

  /* 背景火星余烬 */
  function bindParticles() {
    var canvas = document.getElementById('particles');
    if (!canvas || reduceMotion) return;
    var ctx = canvas.getContext('2d');
    var dots = [];
    function resize() {
      canvas.width = innerWidth; canvas.height = innerHeight;
      var count = Math.min(70, Math.floor(innerWidth * innerHeight / 22000));
      dots = Array.from({ length: count }, function () {
        return {
          x: Math.random() * canvas.width, y: Math.random() * canvas.height,
          vx: (Math.random() - .5) * .3, vy: -(Math.random() * .35 + .12),
          r: Math.random() * 1.8 + .6
        };
      });
    }
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = getComputedStyle(root).getPropertyValue('--accent').trim() || '#E44C3D';
      dots.forEach(function (d) {
        d.x += d.vx; d.y += d.vy;
        if (d.y < -4) { d.y = canvas.height + 4; d.x = Math.random() * canvas.width; }
        if (d.x < 0 || d.x > canvas.width) d.vx *= -1;
        ctx.globalAlpha = .45;
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
      });
      ctx.globalAlpha = 1;
      requestAnimationFrame(draw);
    }
    resize(); draw(); addEventListener('resize', resize);
  }

  /* 卡片 3D 倾斜 + 第三方按钮磁吸 */
  function bindMotion() {
    if (reduceMotion) return;
    var card = document.querySelector('.auth-card');
    card.addEventListener('pointermove', function (e) {
      var r = card.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - .5;
      var py = (e.clientY - r.top) / r.height - .5;
      card.style.transform = 'perspective(1200px) rotateY(' + (px * 3) + 'deg) rotateX(' + (-py * 3) + 'deg)';
    });
    card.addEventListener('pointerleave', function () { card.style.transform = ''; });
    document.querySelectorAll('.oauth button').forEach(function (btn) {
      btn.addEventListener('pointermove', function (e) {
        var r = btn.getBoundingClientRect();
        var mx = e.clientX - r.left - r.width / 2;
        var my = e.clientY - r.top - r.height / 2;
        btn.style.transform = 'translate(' + (mx * .22) + 'px, ' + (my * .3) + 'px)';
      });
      btn.addEventListener('pointerleave', function () { btn.style.transform = ''; });
    });
  }

  window.Auth = {
    init: function (opts) {
      bindEye();
      bindDialog();
      bindForm(opts);
      if (opts.confirmId) bindConfirm(opts.confirmId);
      bindParticles();
      bindMotion();
    }
  };
})();
