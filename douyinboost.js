// ==UserScript==
// @name         通用视频自动最高画质
// @namespace    https://example.com
// @version      1.4.0
// @description  自动选择抖音/B站最高非会员画质（底层级视频源监听，解决连续切换失效问题）
// @author       Gemini
// @match        *://*.douyin.com/*
// @match        *://*.bilibili.com/video/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict'

  const DEBUG = true
  let hasSetQuality = false
  let lastVideoSrc = '' // 记录上一次播放的视频底层源地址

  function log (...args) {
    if (DEBUG) console.log('[AutoQuality]', ...args)
  }

  function wait (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function triggerMouseEvent (element, type) {
    if (!element) return
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window
    }))
  }

  // =========================================
  // 抖音直播 / 视频画质动态排序与过滤
  // =========================================
  async function setDouyinQuality () {
    try {
      const qualityRoot = document.querySelector('.gear.isSmoothSwitchClarityLogin') || document.querySelector('.QualitySwitchNewPlugin')
      if (!qualityRoot) return false

      let items = [...qualityRoot.querySelectorAll('.item, .jJxS_8vy')]
      if (!items.length) return false

      // 过滤未登录/锁定的不可用项
      items = items.filter(item => {
        const html = item.innerHTML.toLowerCase()
        if (html.includes('lock') || html.includes('login-tag')) return false
        return true
      })

      const getQualityScore = (el) => {
        const text = el.innerText.toUpperCase()
        if (text.includes('4K')) return 4000
        if (text.includes('2K')) return 2000
        const match = text.match(/(\d+)/)
        if (match) return parseInt(match[1], 10)
        if (text.includes('原画')) return 1081
        if (text.includes('蓝光')) return 1080
        if (text.includes('超清')) return 720
        if (text.includes('高清')) return 540
        if (text.includes('智能')) return 0
        return -1
      }

      items.sort((a, b) => getQualityScore(b) - getQualityScore(a))

      const best = items[0]
      if (!best || getQualityScore(best) <= 0) return false

      const isActive = best.classList.contains('selected') || best.classList.contains('active')

      if (!isActive) {
        log('抖音执行画质切换 ->', best.innerText.trim())
        best.click()
        return true
      } else {
        log('抖音当前已是最高画质:', best.innerText.trim())
        return true
      }
    } catch (err) {
      console.error('抖音画质切换异常:', err)
      return false
    }
  }

  // =========================================
  // B站视频
  // =========================================
  async function setBilibiliQuality () {
    try {
      const qualityButton = document.querySelector('.bpx-player-ctrl-quality')
      if (!qualityButton) return false

      triggerMouseEvent(qualityButton, 'mouseenter')
      triggerMouseEvent(qualityButton, 'mouseover')
      await wait(200)

      const menuItems = [...document.querySelectorAll('.bpx-player-ctrl-quality-menu-item')]
      if (!menuItems.length) return false

      const availableItems = menuItems.filter(item => !item.querySelector('.bpx-player-ctrl-quality-badge'))
      if (!availableItems.length) return false

      const sorted = availableItems.sort((a, b) => Number(b.dataset.value) - Number(a.dataset.value))
      const best = sorted[0]
      if (!best) return false

      if (!best.classList.contains('bpx-state-active')) {
        log('B站执行画质切换 ->', best.innerText.trim())
        best.click()
      } else {
        log('B站当前已是最高画质:', best.innerText.trim())
      }

      triggerMouseEvent(qualityButton, 'mouseleave')
      return true
    } catch (err) {
      console.error('B站画质切换异常:', err)
      return false
    }
  }

  // =========================================
  // 【核心升级】带重试机制的控制流
  // =========================================
  async function executeWithRetry (retryCount = 0) {
    if (hasSetQuality && retryCount === 0) return

    let success = false
    const url = location.href

    if (url.includes('douyin.com')) {
      success = await setDouyinQuality()
    } else if (url.includes('bilibili.com/video/')) {
      success = await setBilibiliQuality()
    }

    if (success) {
      hasSetQuality = true
    } else if (retryCount < 5) {
      // 如果因为DOM没加载完导致失败，每隔500ms重试一次，最多5次
      setTimeout(() => {
        executeWithRetry(retryCount + 1)
      }, 500)
    }
  }

  // =========================================
  // 【底层级监听】视频流特征监听器
  // =========================================
  function watchVideoChange () {
    // 1000ms 定时检查底层 <video> 标签的 src，如果是短视频下滑或者连播，src 必定会变
    setInterval(() => {
      const videoElement = document.querySelector('video')
      if (videoElement) {
        const currentSrc = videoElement.currentSrc || videoElement.src

        // 如果发现正在播放的视频源地址变了，说明用户换了视频
        if (currentSrc && currentSrc !== lastVideoSrc) {
          lastVideoSrc = currentSrc
          hasSetQuality = false // 解开状态锁
          log('【检测到视频源变更】开始为新视频匹配最高画质...')

          // 给新视频一点点加载缓冲时间，然后执行
          setTimeout(() => {
            executeWithRetry()
          }, 400)
        }
      }
    }, 1000)
  }

  // 启动视频流监听
  watchVideoChange()

  // 兜底初次注入执行
  setTimeout(() => executeWithRetry(), 1500)
})()
