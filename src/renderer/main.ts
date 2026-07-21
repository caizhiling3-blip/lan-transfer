import 'element-plus/dist/index.css'
import './styles.css'

import ElementPlus from 'element-plus'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'

createApp(App).use(createPinia()).use(ElementPlus).mount('#app')
