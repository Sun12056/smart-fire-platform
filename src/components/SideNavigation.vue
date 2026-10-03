<template>
  <nav class="side-nav">
    <router-link
      v-for="item in navItems"
      :key="item.path"
      :to="item.path"
      class="nav-item"
      active-class="active"
    >
      <span class="nav-icon">
        <!-- Dashboard / 综合态势 -->
        <svg v-if="item.icon === 'dashboard'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="12" width="4" height="9" rx="0.5"/>
          <rect x="10" y="6" width="4" height="15" rx="0.5"/>
          <rect x="17" y="9" width="4" height="12" rx="0.5"/>
        </svg>
        <!-- Person / 生命感知 -->
        <svg v-if="item.icon === 'person'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="7" r="3"/>
          <path d="M2 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
          <circle cx="17" cy="7" r="2.5" opacity="0.6"/>
          <path d="M16 14h2a3 3 0 0 1 3 3v2" opacity="0.6"/>
        </svg>
        <!-- Building / 楼宇态势 -->
        <svg v-if="item.icon === 'building'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 21V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v16"/>
          <path d="M15 21V9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v12"/>
          <line x1="6" y1="8" x2="9" y2="8"/>
          <line x1="6" y1="12" x2="9" y2="12"/>
          <line x1="6" y1="16" x2="9" y2="16"/>
          <line x1="18" y1="12" x2="18" y2="12"/>
          <line x1="18" y1="16" x2="18" y2="16"/>
        </svg>
        <!-- Signal / 设备管理 -->
        <svg v-if="item.icon === 'signal'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="2"/>
          <path d="M8.5 8.5A5 5 0 0 0 8.5 15.5"/>
          <path d="M15.5 8.5A5 5 0 0 1 15.5 15.5"/>
          <path d="M5.5 5.5A9 9 0 0 0 5.5 18.5"/>
          <path d="M18.5 5.5A9 9 0 0 1 18.5 18.5"/>
        </svg>
        <!-- Bulb / 智能照明 -->
        <svg v-if="item.icon === 'bulb'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18h6"/>
          <path d="M10 21h4"/>
          <path d="M12 3a6 6 0 0 1 4 10.5c-.5.5-1 1.5-1 2.5H9c0-1-.5-2-1-2.5A6 6 0 0 1 12 3z"/>
        </svg>
        <!-- Search / 远程巡检 -->
        <svg v-if="item.icon === 'search'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7"/>
          <line x1="16.5" y1="16.5" x2="21" y2="21"/>
        </svg>
        <!-- Warning / 智能告警 -->
        <svg v-if="item.icon === 'warning'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3L2 20h20L12 3z"/>
          <line x1="12" y1="9" x2="12" y2="14"/>
          <circle cx="12" cy="17.5" r="0.5" fill="currentColor"/>
        </svg>
        <!-- Door / 智能疏散 -->
        <svg v-if="item.icon === 'door'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 21V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v16"/>
          <line x1="4" y1="21" x2="16" y2="21"/>
          <line x1="16" y1="12" x2="16" y2="12"/>
          <path d="M19 12h2v9h-2"/>
          <line x1="20" y1="12" x2="20" y2="21" opacity="0.5"/>
        </svg>
        <!-- 日志 / 后台日志 -->
        <svg v-if="item.icon === 'emergency'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 17h18l-2-7H5l-2 7z"/>
          <circle cx="7.5" cy="17.5" r="2"/>
          <circle cx="16.5" cy="17.5" r="2"/>
          <line x1="9.5" y1="17.5" x2="14.5" y2="17.5"/>
          <path d="M12 7V4"/>
          <line x1="10" y1="5" x2="14" y2="5"/>
        </svg>
        <!-- Route / 疏散路线规划 -->
        <svg v-if="item.icon === 'route'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="6" cy="6" r="2.5"/>
          <circle cx="18" cy="18" r="2.5"/>
          <path d="M6 8.5V14a2 2 0 0 0 2 2h6.5"/>
          <path d="M16 4.5h2.5V11"/>
        </svg>
      </span>
      <span class="nav-label">{{ item.label }}</span>
      <span class="nav-indicator" v-if="item.badge">{{ item.badge }}</span>
    </router-link>

    <!-- 分组标题（设备管理） -->
    <div v-for="grp in groupHeaders" :key="grp.key" class="nav-group">
      <div class="nav-group-head">
        <span class="nav-icon">
          <svg v-if="grp.icon === 'signal'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="2"/>
            <path d="M8.5 8.5A5 5 0 0 0 8.5 15.5"/><path d="M15.5 8.5A5 5 0 0 1 15.5 15.5"/>
            <path d="M5.5 5.5A9 9 0 0 0 5.5 18.5"/><path d="M18.5 5.5A9 9 0 0 1 18.5 18.5"/>
          </svg>
        </span>
        <span class="nav-label">{{ grp.label }}</span>
      </div>
      <router-link
        v-for="c in grp.children"
        :key="c.path"
        :to="c.path"
        class="nav-item nav-sub"
        active-class="active"
      >
        <span class="nav-icon">
          <svg v-if="c.icon === 'signal'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M8.5 8.5A5 5 0 0 0 8.5 15.5"/><path d="M15.5 8.5A5 5 0 0 1 15.5 15.5"/><path d="M5.5 5.5A9 9 0 0 0 5.5 18.5"/><path d="M18.5 5.5A9 9 0 0 1 18.5 18.5"/></svg>
          <svg v-if="c.icon === 'warning'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3L2 20h20L12 3z"/><line x1="12" y1="9" x2="12" y2="14"/><circle cx="12" cy="17.5" r="0.5" fill="currentColor"/></svg>
          <svg v-if="c.icon === 'bulb'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 1 4 10.5c-.5.5-1 1.5-1 2.5H9c0-1-.5-2-1-2.5A6 6 0 0 1 12 3z"/></svg>
          <svg v-if="c.icon === 'search'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
        </span>
        <span class="nav-label">{{ c.label }}</span>
        <span class="nav-indicator" v-if="c.badge">{{ c.badge }}</span>
      </router-link>
    </div>

    <div class="nav-footer">
      <div class="version-info num-font">
        <span>v1.0.0 Demo</span>
      </div>
    </div>
  </nav>
</template>

<script setup>
import { computed } from 'vue'
import { useFireStore } from '../stores/fireStore'

const store = useFireStore()

const navItems = computed(() => [
  { path: '/dashboard', label: '楼宇态势', icon: 'dashboard' },
  { path: '/building', label: '消防态势', icon: 'building' },
  { path: '/person', label: '生命感知', icon: 'person' },
  { path: '/evacuation', label: '智能疏散', icon: 'door' },
  { path: '/route-plan', label: '疏散路径', icon: 'route' },
  { path: '/emergency', label: '后台日志', icon: 'emergency' },
])

const groupHeaders = computed(() => [
  {
    key: 'devices',
    label: '设备管理',
    icon: 'signal',
    children: [
      { path: '/devices', label: '设备状态', icon: 'signal' },
      { path: '/alarms', label: '智能告警', icon: 'warning', badge: store.alarmStats.pending > 0 ? store.alarmStats.pending : '' },
      { path: '/lighting', label: '智能照明', icon: 'bulb' },
      { path: '/inspection', label: '远程巡检', icon: 'search' },
    ],
  },
])
</script>

<style scoped>
.side-nav {
  width: 64px;
  background: #0A0E1A;
  border-right: 1px solid rgba(76,201,240,0.15);
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  transition: width 0.3s ease;
  overflow: hidden;
  box-shadow: 1px 0 0 rgba(27, 31, 42, 0.03);
}

.side-nav:hover {
  width: 168px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 48px;
  padding: 0 20px;
  margin: 2px 0;
  color: #94A3B8;
  text-decoration: none;
  transition: all 0.2s;
  position: relative;
  white-space: nowrap;
  overflow: hidden;
}

.nav-item:hover {
  background: rgba(76,201,240,0.08);
  color: #4CC9F0;
}

.nav-item.active {
  background: rgba(76,201,240,0.12);
  color: #4CC9F0;
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 60%;
  background: rgba(76,201,240,0.15);
  border-radius: 0 4px 4px 0;
}

/* 分组标题（设备管理） */
.nav-group {
  margin: 4px 0;
}

.nav-group-head {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 20px;
  margin: 2px 0;
  color: #64748B;
  font-size: var(--fs-xs);
  letter-spacing: 1px;
  white-space: nowrap;
  overflow: hidden;
  border-top: 1px solid rgba(76,201,240,0.1);
  border-bottom: 1px solid rgba(76,201,240,0.06);
  margin-top: 8px;
  padding-top: 4px;
}

.nav-sub {
  padding-left: 32px;
  height: 42px;
}

.nav-sub .nav-icon {
  width: 18px;
  height: 18px;
}

.nav-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.nav-label {
  font-size: var(--fs-md);
  opacity: 0;
  transition: opacity 0.2s;
  flex: 1;
  letter-spacing: 0.5px;
  font-weight: 500;
}

.side-nav:hover .nav-label {
  opacity: 1;
}

.nav-indicator {
  background: var(--fire-red);
  color: white;
  font-size: var(--fs-tiny);
  padding: 1px 5px;
  border-radius: 2px;
  text-align: center;
  opacity: 0;
  transition: opacity 0.2s;
  line-height: var(--lh-tight);
}

.side-nav:hover .nav-indicator {
  opacity: 1;
}

.nav-footer {
  margin-top: auto;
  padding: 8px 12px;
}

.version-info {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  text-align: center;
  opacity: 0;
  transition: opacity 0.2s;
}

.side-nav:hover .version-info {
  opacity: 1;
}
</style>
