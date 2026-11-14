<!--
  AUTH-8 · 常驻 Demo 标识（mock 模式）
  要求：
    · 顶部常驻说明条 + 右下角 DEMO 角标；
    · mock 模式下**始终显示**，且**不可关闭**；
    · 非 mock 模式不渲染。
-->
<template>
  <div v-if="visible" class="demo-topbar" role="status" aria-live="polite">
    <span class="demo-tag">DEMO</span>
    <span class="demo-text">
      当前为<strong>演示模式</strong>：页面展示的是<strong>本地模拟数据</strong>，并非真实设备状态、真实人员位置或真实消防指令。<strong>火情与疏散演示为本地模拟推演</strong>，非后端状态机。
    </span>
    <span class="demo-extra">数据源 {{ mode.toUpperCase() }}</span>
  </div>

  <div v-if="visible" class="demo-corner" aria-hidden="true">
    <span class="corner-tag">DEMO</span>
    <span class="corner-sub">模拟数据</span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { dataSource } from '../api'

const mode = dataSource.mode
// mock 模式恒显示；api/demo 模式下由 DataSourceBanner 负责异常提示
const visible = computed(() => dataSource.isMock)
</script>

<style scoped>
.demo-topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 16px;
  background: linear-gradient(90deg, rgba(239, 68, 68, 0.18), rgba(239, 68, 68, 0.06));
  border-bottom: 1px solid rgba(239, 68, 68, 0.45);
  color: #fecaca;
  font-size: 12px;
  letter-spacing: 0.02em;
  flex: 0 0 auto;
  z-index: 1200;
}

.demo-tag {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 3px;
  background: #ef4444;
  color: #fff;
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.08em;
}

.demo-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.demo-text strong {
  color: #fca5a5;
  font-weight: 600;
}

.demo-extra {
  flex: 0 0 auto;
  color: #f87171;
  font-size: 11px;
  opacity: 0.85;
}

.demo-corner {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.92);
  box-shadow: 0 6px 18px rgba(239, 68, 68, 0.35);
  pointer-events: none;
  user-select: none;
}

.corner-tag {
  color: #fff;
  font-weight: 800;
  font-size: 13px;
  letter-spacing: 0.12em;
  line-height: 1.1;
}

.corner-sub {
  color: #fee2e2;
  font-size: 10px;
  line-height: 1.1;
}
</style>
