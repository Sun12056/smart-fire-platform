<!--
  AUTH-8 · 修改密码弹窗
  · force=true 时为强制改密：不可关闭、无取消按钮、点遮罩无效；
  · 成功后由父组件处理跳转（后端已撤销全部 Session，必须重新登录）。
-->
<template>
  <div v-if="modelValue" class="cp-mask" @click.self="onMaskClick">
    <div class="cp-box" role="dialog" aria-modal="true" aria-labelledby="cp-title">
      <h2 id="cp-title" class="cp-title">{{ force ? '首次登录必须修改密码' : '修改密码' }}</h2>
      <p class="cp-desc">
        {{ force
          ? '为保障账号安全，请先设置新密码后再使用平台。修改成功后需要重新登录。'
          : '修改成功后，当前所有登录会话将失效，需要使用新密码重新登录。' }}
      </p>

      <label class="cp-field">
        <span>当前密码</span>
        <input v-model="currentPassword" type="password" autocomplete="current-password" :disabled="submitting" />
      </label>

      <label class="cp-field">
        <span>新密码</span>
        <input v-model="newPassword" type="password" autocomplete="new-password" :disabled="submitting" />
        <small class="cp-hint" :class="{ bad: newPassword && !lengthOk }">
          12–128 个字符（支持中文与符号）；当前 {{ charCount }} 个字符
        </small>
      </label>

      <label class="cp-field">
        <span>确认新密码</span>
        <input v-model="confirmPassword" type="password" autocomplete="new-password" :disabled="submitting" />
        <small v-if="confirmPassword && confirmPassword !== newPassword" class="cp-hint bad">两次输入不一致</small>
      </label>

      <p v-if="message" class="cp-msg" :class="{ bad: !ok }">{{ message }}</p>

      <div class="cp-actions">
        <button v-if="!force" class="btn ghost" :disabled="submitting" @click="close">取消</button>
        <button class="btn primary" :disabled="!canSubmit || submitting" @click="submit">
          {{ submitting ? '提交中…' : '确认修改' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '../stores/authStore'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  force: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'success', 'closed'])

const auth = useAuthStore()

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const message = ref('')
const ok = ref(false)

const charCount = computed(() => Array.from(newPassword.value || '').length)
const lengthOk = computed(() => charCount.value >= 12 && charCount.value <= 128)
const canSubmit = computed(
  () => Boolean(currentPassword.value) && lengthOk.value && newPassword.value === confirmPassword.value,
)

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      currentPassword.value = ''
      newPassword.value = ''
      confirmPassword.value = ''
      message.value = ''
      ok.value = false
      submitting.value = false
    }
  },
)

function close() {
  if (props.force) return
  emit('update:modelValue', false)
  emit('closed')
}

function onMaskClick() {
  if (props.force) return
  close()
}

const ERROR_TEXT = {
  INVALID_INPUT: '新密码不符合要求（12–128 字符，且不能与当前密码相同）',
  INVALID_CREDENTIALS: '当前密码不正确',
  PASSWORD_REUSED: '新密码不能与最近使用过的密码重复',
  CSRF_REJECTED: '请求来源校验失败，请刷新页面后重试',
  PASSWORD_CHANGE_REQUIRED: '请先完成密码修改',
  AUTH_UNAVAILABLE: '认证服务暂不可用，请稍后重试',
  AUTH_CONFIG_INVALID: '认证服务配置异常，请联系管理员',
}

async function submit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  message.value = ''
  try {
    const res = await auth.changePassword(currentPassword.value, newPassword.value)
    if (res.ok) {
      ok.value = true
      message.value = '密码已修改，正在跳转登录页…'
      emit('success')
    } else {
      ok.value = false
      message.value = ERROR_TEXT[res.error] || `修改失败（HTTP ${res.status}）`
    }
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.cp-mask {
  position: fixed;
  inset: 0;
  z-index: 4000;
  background: rgba(3, 7, 18, 0.78);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.cp-box {
  width: 100%;
  max-width: 420px;
  padding: 24px;
  border-radius: 12px;
  background: #111a2e;
  border: 1px solid #1f2a44;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  color: #e5e7eb;
}

.cp-title {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
}

.cp-desc {
  margin: 0 0 16px;
  font-size: 12.5px;
  line-height: 1.7;
  color: #94a3b8;
}

.cp-field {
  display: block;
  margin-bottom: 14px;
}

.cp-field > span {
  display: block;
  margin-bottom: 6px;
  font-size: 12.5px;
  color: #cbd5e1;
}

.cp-field input {
  width: 100%;
  height: 38px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid #24304c;
  background: #0b1220;
  color: #e5e7eb;
  font-size: 14px;
  outline: none;
}

.cp-field input:focus {
  border-color: #4c9ef0;
}

.cp-hint {
  display: block;
  margin-top: 5px;
  font-size: 11.5px;
  color: #64748b;
}

.cp-hint.bad,
.cp-msg.bad {
  color: #f87171;
}

.cp-msg {
  margin: 4px 0 12px;
  font-size: 12.5px;
  color: #34d399;
  line-height: 1.6;
}

.cp-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}

.btn {
  height: 36px;
  padding: 0 16px;
  border-radius: 8px;
  border: 1px solid transparent;
  font-size: 13px;
  cursor: pointer;
}

.btn.primary {
  background: #2563eb;
  color: #fff;
}

.btn.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn.ghost {
  background: transparent;
  border-color: #24304c;
  color: #cbd5e1;
}
</style>
