<!--
  AUTH-8 · 顶栏用户菜单
  取代原 TopHeader 中「管理员」徽章（该徽章实际触发 demoMode，属权限误导）。
  真实身份一律来自 /api/auth/session。
-->
<template>
  <div ref="root" class="user-menu">
    <button class="um-trigger" type="button" @click="open = !open">
      <span class="um-avatar">{{ initial }}</span>
      <span class="um-meta">
        <span class="um-name">{{ auth.displayName || '未登录' }}</span>
        <span class="um-role" :class="auth.role">{{ roleLabel }}</span>
      </span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>

    <div v-if="open" class="um-panel">
      <router-link class="um-item" to="/account" @click="open = false">我的账号</router-link>
      <router-link v-if="auth.isAdmin" class="um-item" to="/admin/users" @click="open = false">用户管理</router-link>
      <button class="um-item" type="button" @click="openPassword">修改密码</button>
      <div class="um-divider"></div>
      <button class="um-item danger" type="button" @click="doLogout">退出登录</button>
    </div>

    <ChangePasswordDialog v-model="passwordOpen" @success="afterPasswordChanged" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/authStore'
import ChangePasswordDialog from './ChangePasswordDialog.vue'

const auth = useAuthStore()
const router = useRouter()

const root = ref(null)
const open = ref(false)
const passwordOpen = ref(false)

const initial = computed(() => {
  const n = auth.displayName || auth.user?.username || '?'
  return Array.from(n)[0] || '?'
})
const roleLabel = computed(() => (auth.role === 'admin' ? '管理员' : auth.role === 'teacher' ? '教师' : '未登录'))

function onClickOutside(e) {
  if (root.value && !root.value.contains(e.target)) open.value = false
}
onMounted(() => document.addEventListener('click', onClickOutside, true))
onBeforeUnmount(() => document.removeEventListener('click', onClickOutside, true))

function openPassword() {
  open.value = false
  passwordOpen.value = true
}

async function doLogout() {
  open.value = false
  await auth.logout()
  // 整页跳转，确保 Pages 中间件重新校验并清除所有前端状态
  window.location.assign('/login')
}

function afterPasswordChanged() {
  passwordOpen.value = false
  window.location.assign('/login')
}
</script>

<style scoped>
.user-menu {
  position: relative;
}

.um-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid rgba(76, 201, 240, 0.18);
  background: rgba(17, 26, 46, 0.75);
  color: #cbd5e1;
  cursor: pointer;
}

.um-trigger:hover {
  border-color: rgba(76, 201, 240, 0.4);
}

.um-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #1d4ed8;
  color: #fff;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.um-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  align-items: flex-start;
}

.um-name {
  font-size: 12.5px;
  color: #e2e8f0;
}

.um-role {
  font-size: 10.5px;
  color: #64748b;
}

.um-role.admin {
  color: #f59e0b;
}

.um-role.teacher {
  color: #38bdf8;
}

.um-panel {
  position: absolute;
  right: 0;
  top: 42px;
  min-width: 168px;
  padding: 6px;
  border-radius: 10px;
  background: #111a2e;
  border: 1px solid #1f2a44;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
  z-index: 2500;
}

.um-item {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #cbd5e1;
  font-size: 13px;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.um-item:hover {
  background: rgba(76, 201, 240, 0.1);
  color: #e2e8f0;
}

.um-item.danger {
  color: #f87171;
}

.um-divider {
  height: 1px;
  margin: 4px 6px;
  background: #1f2a44;
}
</style>
