import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rolldownOptions: { input: { main: 'index.html', review: 'review.html', fixture: 'fixture.html' } },
  },
})
