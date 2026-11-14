import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from '../stores/authStore'
import { resolveGuard } from './guard'

const routes = [
  {
    path: '/',
    redirect: '/dashboard',
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('../views/DashboardView.vue'),
    meta: { title: '楼宇态势' },
  },
  {
    path: '/building',
    name: 'Building',
    component: () => import('../views/BuildingView.vue'),
    meta: { title: '楼宇消防态势' },
  },
  {
    path: '/person',
    name: 'Person',
    component: () => import('../views/PersonView.vue'),
    meta: { title: '生命感知中心' },
  },
  {
    path: '/devices',
    name: 'Devices',
    component: () => import('../views/DeviceView.vue'),
    meta: { title: '设备管理·设备状态' },
  },
  {
    path: '/alarms',
    name: 'Alarms',
    component: () => import('../views/AlarmView.vue'),
    meta: { title: '设备管理·智能告警' },
  },
  {
    path: '/lighting',
    name: 'Lighting',
    component: () => import('../views/LightingView.vue'),
    meta: { title: '设备管理·智能照明' },
  },
  {
    path: '/inspection',
    name: 'Inspection',
    component: () => import('../views/InspectionView.vue'),
    meta: { title: '设备管理·远程巡检' },
  },
  {
    path: '/evacuation',
    name: 'Evacuation',
    component: () => import('../views/EvacuationView.vue'),
    meta: { title: '智能疏散' },
  },
  {
    path: '/route-plan',
    name: 'RoutePlan',
    component: () => import('../views/RoutePlanView.vue'),
    meta: { title: '疏散路径' },
  },
  {
    path: '/emergency',
    name: 'Emergency',
    component: () => import('../views/EmergencyView.vue'),
    meta: { title: '后台日志' },
  },
  // AUTH-8：账号页（所有员工可见）
  {
    path: '/account',
    name: 'Account',
    component: () => import('../views/AccountView.vue'),
    meta: { title: '我的账号' },
  },
  // AUTH-8：用户管理（仅管理员；后端 requireAdmin 为最终授权边界）
  {
    path: '/admin/users',
    name: 'AdminUsers',
    component: () => import('../views/AdminUsersView.vue'),
    meta: { title: '用户管理', requiresAdmin: true },
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

/**
 * AUTH-8 路由守卫：
 *  1. 进入任何页面先确保 Session 状态新鲜（TTL 内不重复请求）；
 *  2. **未认证时主动整页跳转 /login**（SPA 内部切换不产生网络请求，
 *     不能依赖 Pages Middleware，必须在此独立判断）；
 *  3. mustChangePassword=1 时仅允许 /account；
 *  4. requiresAdmin 路由对非管理员重定向到首页。
 * 注意：真正的访问控制在 Pages Functions 与 Worker，前端仅负责体验一致性。
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  await auth.ensureFresh()

  const decision = resolveGuard(
    {
      isAuthenticated: auth.isAuthenticated,
      mustChangePassword: auth.mustChangePassword,
      isAdmin: auth.isAdmin,
    },
    { path: to.path, fullPath: to.fullPath },
    to.meta,
  )

  if (!decision) return true

  if (decision.external) {
    // 整页跳转登录页（保留 SPA 原路径于 next），并中断本次导航
    window.location.assign(decision.external)
    return false
  }
  return decision
})

export default router
