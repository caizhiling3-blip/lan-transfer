import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles.css'

import ElementPlus from 'element-plus'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { initializeTheme } from './composables/use-theme'

initializeTheme()
createApp(App).use(createPinia()).use(ElementPlus).mount('#app')
