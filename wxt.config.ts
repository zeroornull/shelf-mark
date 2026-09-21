import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  srcDir: 'src',
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Shelfmark',
    description: '用 AI 预览并整理 Chrome 书签文件夹',
    minimum_chrome_version: '134',
    permissions: ['bookmarks', 'storage', 'unlimitedStorage', 'sidePanel'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    action: {},
  },
});
