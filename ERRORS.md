# 🐛 Error Log - tmdb-addon-fast

> Tập hợp tất cả lỗi xảy ra trong quá trình phát triển (Auto-generated).

---

## Thống kê nhanh
- **Tổng lỗi**: 1
- **Đã sửa**: 1

---

## [2026-08-19 15:40] - Mismatch Dependencies & ESLint Configuration

- **Type**: Integration
- **Severity**: High
- **File**: `package.json`, `eslint.config.js`, `vite.config.mts`
- **Agent**: mon
- **Root Cause**: `node_modules` chứa phiên bản cũ (cache-manager v3, tailwindcss v3, react 18) không khớp với `package.json` mới (cache-manager v7, tailwindcss v4, react 19), và ESLint quét nhầm thư mục `.agent`.
- **Error Message**: 
  ```
  TypeError: createCache is not a function in addon/lib/getCache.js
  Cannot find package '@tailwindcss/vite' imported from vite.config.mts
  ```
- **Fix Applied**: 
  1. Đồng bộ và cài đặt lại toàn bộ dependencies bằng `npm install --legacy-peer-deps`.
  2. Bổ sung `.agent/**`, `build/**`, `coverage/**` vào danh sách `ignores` của `eslint.config.js`.
  3. Cập nhật `import.meta.dirname` trong `vite.config.mts` cho chuẩn Vite native.
- **Prevention**: Luôn chạy `npm install --legacy-peer-deps` khi checkout sang branch nâng cấp major version dependencies.
- **Status**: Fixed

---

