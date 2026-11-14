<!-- AUTH-8 · 我的账号：展示当前身份与改密入口 -->
<template>
  <div class="account-page">
    <h2 class="page-title">我的账号</h2>

    <div class="card">
      <div class="row"><span class="k">用户名</span><span class="v">{{ auth.user?.username || '-' }}</span></div>
      <div class="row"><span class="k">显示名</span><span class="v">{{ auth.user?.displayName || '-' }}</span></div>
      <div class="row">
        <span class="k">角色</span>
        <span class="v">
          <span class="role-tag" :class="auth.role">{{ auth.role === 'admin' ? '管理员' : auth.role === 'teacher' ? '教师' : '-' }}</span>
        </span>
      </div>
      <div class="row"><span class="k">密码状态</span><span class="v">{{ auth.mustChangePassword ? '需要修改初始密码' : '已设置' }}</span></div>
    </div>

    <div class="card">
      <p class="tip">修改密码后，当前所有登录会话会立即失效，需要使用新密码重新登录。</p>
      <button class="btn" type="button" @click="open = true">修改密码</button>
    </div>

    <ChangePasswordDialog v-model="open" @success="onChanged" />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useAuthStore } from '../stores/authStore'
import ChangePasswordDialog from '../components/ChangePasswordDialog.vue'

const auth = useAuthStore()
const open = ref(false)

function onChanged() {
  open.value = false
  window.location.assign('/login')
}
</script>

<style scoped>
.account-page {
  padding: 20px 24px;
  color: #e5e7eb;
}

.page-title {
  margin: 0 0 16px;
  font-size: 18px;
  font-weight: 600;
}

.card {
  max-width: 520px;
  margin-bottom: 16px;
  padding: 16px 18px;
  border-radius: 10px;
  background: #111a2e;
  border: 1px solid #1f2a44;
}

.row {
  display: flex;
  justify-content: space-between;
  padding: 7px 0;
  border-bottom: 1px dashed rgba(31, 42, 68, 0.8);
  font-size: 13px;
}

.row:last-child {
  border-bottom: 0;
}

.k {
  color: #94a3b8;
}

.v {
  color: #e2e8f0;
}

.role-tag {
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  background: rgba(148, 163, 184, 0.15);
}

.role-tag.admin {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
}

.role-tag.teacher {
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.12);
}

.tip {
  margin: 0 0 12px;
  font-size: 12.5px;
  color: #94a3b8;
  line-height: 1.7;
}

.btn {
  height: 36px;
  padding: 0 16px;
  border-radius: 8px;
  border: 0;
  background: #2563eb;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
</style>
