<!--
  AUTH-8 · 用户管理（仅管理员可见）
  依赖后端 GET /api/auth/users（分页、不含敏感字段）。
  所有变更操作均经 Worker requireAdmin 授权；前端过滤仅为 UX。
-->
<template>
  <div class="admin-users">
    <div class="head">
      <h2 class="page-title">用户管理</h2>
      <button class="btn ghost" type="button" :disabled="loading" @click="load">刷新</button>
    </div>

    <p v-if="error" class="alert">{{ error }}</p>

    <!-- 创建 -->
    <div class="card">
      <h3 class="card-title">新建账号</h3>
      <div class="form-grid">
        <label><span>用户名</span><input v-model.trim="form.username" placeholder="如 huangyingying" :disabled="creating" /></label>
        <label><span>显示名</span><input v-model.trim="form.displayName" placeholder="如 黄莹莹" :disabled="creating" /></label>
        <label>
          <span>角色</span>
          <select v-model="form.role" :disabled="creating">
            <option value="teacher">教师</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <label><span>初始密码（≥12 位）</span><input v-model="form.tempPassword" type="password" autocomplete="new-password" :disabled="creating" /></label>
      </div>
      <div class="actions">
        <button class="btn primary" type="button" :disabled="creating || !formValid" @click="createUser">
          {{ creating ? '创建中…' : '创建账号' }}
        </button>
        <span class="hint">新账号首次登录必须修改密码</span>
      </div>
      <p v-if="formMsg" class="alert" :class="{ ok: formOk }">{{ formMsg }}</p>
    </div>

    <!-- 列表 -->
    <div class="card">
      <h3 class="card-title">账号列表（共 {{ total }} 个）</h3>
      <table class="tbl">
        <thead>
          <tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>首次改密</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td class="mono">{{ u.username }}</td>
            <td>{{ u.displayName || '-' }}</td>
            <td><span class="role-tag" :class="u.role">{{ u.role === 'admin' ? '管理员' : '教师' }}</span></td>
            <td><span class="status-tag" :class="u.status">{{ u.status === 'active' ? '启用' : '已禁用' }}</span></td>
            <td>{{ u.mustChangePassword ? '待改密' : '已完成' }}</td>
            <td class="ops">
              <button class="link" type="button" @click="toggleStatus(u)">
                {{ u.status === 'active' ? '禁用' : '启用' }}
              </button>
              <button class="link" type="button" @click="resetPassword(u)">重置密码</button>
            </td>
          </tr>
          <tr v-if="!users.length && !loading">
            <td colspan="6" class="empty">暂无数据</td>
          </tr>
        </tbody>
      </table>

      <div class="pager">
        <button class="btn ghost" type="button" :disabled="offset === 0 || loading" @click="prev">上一页</button>
        <span class="pager-info">{{ offset + 1 }}–{{ Math.min(offset + limit, total) }} / {{ total }}</span>
        <button class="btn ghost" type="button" :disabled="offset + limit >= total || loading" @click="next">下一页</button>
      </div>
    </div>

    <p v-if="opMsg" class="alert" :class="{ ok: opOk }">{{ opMsg }}</p>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { authClient } from '../api/authClient'

const users = ref([])
const total = ref(0)
const limit = ref(20)
const offset = ref(0)
const loading = ref(false)
const error = ref('')

const form = ref({ username: '', displayName: '', role: 'teacher', tempPassword: '' })
const creating = ref(false)
const formMsg = ref('')
const formOk = ref(false)

const opMsg = ref('')
const opOk = ref(false)

const formValid = computed(
  () => Boolean(form.value.username) && Array.from(form.value.tempPassword || '').length >= 12,
)

const ERR = {
  FORBIDDEN: '无权限执行该操作',
  CONFLICT: '用户名已存在或存在冲突',
  LAST_ADMIN_PROTECTED: '系统必须保留至少一个启用状态的管理员',
  SELF_MODIFY_FORBIDDEN: '不能禁用或降级自己的账号',
  INVALID_INPUT: '输入不合法（密码需 12–128 字符）',
  PASSWORD_CHANGE_REQUIRED: '请先修改初始密码',
  AUTH_UNAVAILABLE: '认证服务暂不可用',
  NOT_FOUND: '账号不存在',
}

async function load() {
  loading.value = true
  error.value = ''
  const res = await authClient.listUsers({ limit: limit.value, offset: offset.value })
  if (res.ok) {
    users.value = res.body?.users || []
    total.value = Number(res.body?.total ?? 0)
  } else {
    error.value = ERR[res.body?.error] || `加载失败（HTTP ${res.status}）`
    users.value = []
  }
  loading.value = false
}

function prev() {
  offset.value = Math.max(0, offset.value - limit.value)
  load()
}
function next() {
  offset.value += limit.value
  load()
}

async function createUser() {
  if (!formValid.value || creating.value) return
  creating.value = true
  formMsg.value = ''
  const res = await authClient.createUser({
    username: form.value.username,
    displayName: form.value.displayName || null,
    role: form.value.role,
    tempPassword: form.value.tempPassword,
  })
  formOk.value = res.ok
  if (res.ok) {
    formMsg.value = `账号 ${form.value.username} 已创建，首次登录需修改密码`
    form.value = { username: '', displayName: '', role: 'teacher', tempPassword: '' }
    offset.value = 0
    await load()
  } else {
    formMsg.value = ERR[res.body?.error] || `创建失败（HTTP ${res.status}）`
  }
  creating.value = false
}

async function toggleStatus(u) {
  const nextStatus = u.status === 'active' ? 'disabled' : 'active'
  const res = await authClient.updateUser(u.id, { status: nextStatus })
  opOk.value = res.ok
  opMsg.value = res.ok ? (nextStatus === 'disabled' ? '已禁用' : '已启用') : ERR[res.body?.error] || `操作失败（HTTP ${res.status}）`
  if (res.ok) await load()
}

async function resetPassword(u) {
  const pw = window.prompt(`为 ${u.username} 设置新的临时密码（至少 12 位）：`, '')
  if (pw === null) return
  if (Array.from(pw).length < 12) {
    opOk.value = false
    opMsg.value = '临时密码至少 12 位'
    return
  }
  const res = await authClient.resetPassword(u.id, pw)
  opOk.value = res.ok
  opMsg.value = res.ok ? '密码已重置，该账号所有会话已失效' : ERR[res.body?.error] || `重置失败（HTTP ${res.status}）`
  if (res.ok) await load()
}

onMounted(load)
</script>

<style scoped>
.admin-users {
  padding: 20px 24px;
  color: #e5e7eb;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.page-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.card {
  margin-bottom: 16px;
  padding: 16px 18px;
  border-radius: 10px;
  background: #111a2e;
  border: 1px solid #1f2a44;
}

.card-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: #cbd5e1;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

label > span {
  display: block;
  margin-bottom: 5px;
  font-size: 12px;
  color: #94a3b8;
}

input,
select {
  width: 100%;
  height: 34px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid #24304c;
  background: #0b1220;
  color: #e5e7eb;
  font-size: 13px;
  outline: none;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.hint {
  font-size: 11.5px;
  color: #64748b;
}

.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 7px;
  border: 1px solid transparent;
  font-size: 12.5px;
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

.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.tbl th,
.tbl td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid rgba(31, 42, 68, 0.8);
}

.tbl th {
  color: #94a3b8;
  font-weight: 500;
}

.mono {
  font-family: ui-monospace, Consolas, monospace;
}

.role-tag,
.status-tag {
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11.5px;
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

.status-tag.active {
  color: #34d399;
  background: rgba(52, 211, 153, 0.12);
}

.status-tag.disabled {
  color: #f87171;
  background: rgba(248, 113, 113, 0.12);
}

.ops {
  white-space: nowrap;
}

.link {
  margin-right: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #60a5fa;
  font-size: 12.5px;
  cursor: pointer;
}

.empty {
  text-align: center;
  color: #64748b;
  padding: 18px 0;
}

.pager {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.pager-info {
  font-size: 12px;
  color: #94a3b8;
}

.alert {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: #f87171;
}

.alert.ok {
  color: #34d399;
}
</style>
