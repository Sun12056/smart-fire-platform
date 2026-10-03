import { createRouter, createWebHashHistory } from 'vue-router'

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
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

export default router
