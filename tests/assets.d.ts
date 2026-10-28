/**
 * 测试环境的静态资源模块声明。
 *
 * tests/ 由 tsconfig.node.json 直接包含，而 node 端类型检查不含
 * vite/client（*.png 模块声明）；被测的 pet-animation.ts 静态导入
 * 素材 PNG，此声明与 vite/client 语义保持一致，使 node tsc 可通过。
 * renderer 正式构建仍由 tsconfig.web.json + vite/client 覆盖。
 */
declare module '*.png' {
  const url: string
  export default url
}
