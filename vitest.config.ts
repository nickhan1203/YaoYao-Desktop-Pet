import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只测试纯逻辑（Node 环境即可运行），
    // 窗口、托盘、IPC 等行为按项目规则在两端实机验收。
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
