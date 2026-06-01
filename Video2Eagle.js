// ==UserScript==
// @name         Save Douyin Video Frame To Eagle
// @namespace    bilinote
// @version      0.4.1
// @description  Capture the current frame of the largest visible video on Douyin and save it to Eagle with extracted title, tags, and author URL.
// @author       Codex
// @match        http://*/*
// @match        https://*/*
// @match        file:///*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      localhost:41593
// @connect      localhost:41595
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    "use strict";

    // ============================================================
    // 配置常量
    // ============================================================

    /** 是否使用 Eagle API v2.0（false 则使用 v1.0） */
    let USE_API_V2 = true;
    /** Eagle API v1.0 地址 */
    const EAGLE_URL_V1 = "http://localhost:41593";
    /** Eagle API v2.0 地址 */
    const EAGLE_URL_V2 = "http://localhost:41595/api/item/addFromURL";
    /** 触发保存的快捷键 */
    const HOTKEY = "x";
    /** 脚本版本标识，随请求发送给 Eagle 用于追踪 */
    const SCRIPT_VERSION = "userscript-0.4.1";

    function isInstagramHost(hostname = location.hostname) {
        return hostname === "instagram.com" || hostname.endsWith(".instagram.com");
    }

    // ============================================================
    // 文本工具函数
    // ============================================================

    /**
     * 清理并截断字符串。
     * - 移除控制字符（U+0000~U+001F、U+007F）
     * - 合并多余空白
     * - 截断到指定最大长度
     *
     * @param {*} value - 输入值
     * @param {number} maxLength - 最大字符长度
     * @returns {string} 处理后的字符串
     */
    function trimToLength(value, maxLength) {
        if (!value) {
            return "";
        }

        return String(value)
            .replace(/[\u0000-\u001f\u007f]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, maxLength);
    }

    /**
     * 数字补零到两位（如 3 → "03"）。
     * @param {number} value
     * @returns {string}
     */
    function pad2(value) {
        return String(value).padStart(2, "0");
    }

    /**
     * 格式化当前时间为 "YYYY-MM-DD HH:mm:ss" 格式。
     * 用于生成标题中的时间戳，保证每次保存标题唯一。
     * @param {Date} [date=new Date()]
     * @returns {string}
     */
    function formatCurrentTimeToSecond(date = new Date()) {
        return [
            date.getFullYear(),
            pad2(date.getMonth() + 1),
            pad2(date.getDate())
        ].join("-") + " " + [
            pad2(date.getHours()),
            pad2(date.getMinutes()),
            pad2(date.getSeconds())
        ].join(":");
    }

    /**
     * 补全 URL：处理协议缺失（// → https:）、相对路径等情况。
     * @param {string} url - 原始 URL
     * @returns {string} 完整的绝对 URL
     */
    function normalizeUrl(url) {
        if (!url) {
            return location.href;
        }

        // 处理协议相对 URL，如 //example.com/path
        if (url.startsWith("//")) {
            return `https:${url}`;
        }

        // 用当前页面 URL 做基准解析相对路径
        return new URL(url, location.href).href;
    }

    /**
     * 数组去重并过滤空值。
     * @param {Array} values
     * @returns {Array}
     */
    function unique(values) {
        return Array.from(new Set(values.filter(Boolean)));
    }

    // ============================================================
    // DOM 文本提取（用于从视频描述等区域提取干净的文本内容）
    // ============================================================

    /**
     * 从元素中提取文本，移除所有 <img> 标签。
     * 用于获取作者昵称等纯文本内容，避免混入表情图片的 alt 文字。
     * @param {Element} element
     * @returns {string}
     */
    function extractTextWithoutImages(element) {
        if (!element) {
            return "";
        }

        // 克隆节点避免影响页面
        const clone = element.cloneNode(true);
        clone.querySelectorAll("img").forEach((img) => img.remove());

        return clone.textContent
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * 提取纯文本，移除 <a>、<button>、<img> 标签。
     * 用于从视频描述中提取无链接干扰的纯文本标题。
     * @param {Element} element
     * @returns {string}
     */
    function extractPlainText(element) {
        if (!element) {
            return "";
        }

        const clone = element.cloneNode(true);
        clone.querySelectorAll("a, button, img").forEach((node) => node.remove());

        return clone.textContent
            .replace(/\s+/g, " ")
            .trim();
    }

    // ============================================================
    // 媒体元素查找 — 找出用户当前要保存的视频或图片
    // ============================================================

    /**
     * 遍历所有 <video> 元素，返回可视区域面积最大的一个。
     * 判断条件：元素在视口内、有实际分辨率（videoWidth/videoHeight > 0）。
     * @returns {HTMLVideoElement|null}
     */
    function findVisibleVideo() {
        if (window.location.href.includes("recommend")){
            // 抖音推荐页特殊处理：优先找当前活跃视频或直播中的视频元素，避免误取其他视频
            // 1. 只在当前激活的推荐流容器里找
            const container = document.querySelector("#slidelist[data-active='true']");
            if (!container) return null;

            // 2. 核心逻辑：有活跃视频认视频，没活跃视频认直播，彻底无视 feed-video 残留节点
            const video = container.querySelector("[data-e2e='feed-active-video']");
            const live = container.querySelector("[data-e2e='feed-live']");

            if (video) {
                return video.querySelector("video[src]") || null;
            } else if (live) {
                return live.querySelector("video") || null;
            }
            return null;
        } else {
            // 通用处理：全局找视频，按照可见面积选最大的
            let videos = Array.from(document.querySelectorAll("video"));
            let bestVideo = null;
            let maxArea = 0;

            for (const video of videos) {
                const rect = video.getBoundingClientRect();
                // 检查视频是否在视口内（有交集即可，不要求完全可见）
                const visible =
                    rect.width > 0 &&
                    rect.height > 0 &&
                    rect.bottom > 0 &&
                    rect.right > 0 &&
                    rect.top < window.innerHeight &&
                    rect.left < window.innerWidth;

                // videoWidth/videoHeight 为 0 表示视频尚未加载元数据
                if (!visible || !video.videoWidth || !video.videoHeight) {
                    continue;
                }

                const area = rect.width * rect.height;
                if (area > maxArea) {
                    maxArea = area;
                    bestVideo = video;
                }
            }
            return bestVideo;
        }
        return null;

    }

    /**
     * 判断 DOM 元素在当前视口中是否可见。
     * 检查顺序：CSS display → visibility → opacity → 视口边界。
     * @param {Element} element
     * @returns {boolean}
     */
    function isElementVisible(element) {
        if (!(element instanceof Element)) return false;

        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
            return false;
        }

        const rect = element.getBoundingClientRect();
        return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
        );
    }

    /**
     * 从指定节点向上冒泡查找最近的 <img> 元素。
     * 用于 elementFromPoint 命中非图片元素时，向上找到包裹的图片。
     * @param {Node|null} node
     * @returns {HTMLImageElement|null}
     */
    function getClosestImageElement(node) {
        while (node) {
            if (node instanceof HTMLImageElement) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    function getClosestMediaElement(node) {
        while (node) {
            if (node instanceof HTMLImageElement || node instanceof HTMLVideoElement) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    /**
     * 计算元素在视口内的可见区域面积（考虑视口裁剪）。
     * 用于比较多个图片谁在当前屏幕中占据更多空间。
     * @param {DOMRect} rect - getBoundingClientRect 返回的矩形
     * @returns {number} 可见面积（像素平方）
     */
    function getVisibleRectArea(rect) {
        // 将矩形裁剪到视口范围内
        const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
        const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
        return width * height;
    }

    /**
     * 判断图片是否属于当前活跃的轮播项。
     * 通过检查图片祖先元素上是否有轮播组件活跃状态的 CSS 类名。
     * 覆盖 Swiper、Slick、自研轮播等多种实现。
     * @param {HTMLImageElement} image
     * @returns {boolean}
     */
    function isCurrentImageCandidate(image) {
        if (!image) {
            return false;
        }

        return !!image.closest(
            ".swiper-slide-active, .slick-active, .slick-current, [aria-hidden='false'], .image-item.active, .image-item.is-active, .image-wrapper.active, .carousel__item--active, .active, .current"
        );
    }

    /**
     * 从常见轮播组件的 DOM 结构中直接查找当前显示的图片。
     * 使用组合选择器（如 .swiper-slide-active img）精确匹配。
     * @returns {HTMLImageElement|null}
     */
    function findCurrentCarouselImage() {
        const selectors = [
            // ".swiper-slide-active img",            // Swiper 轮播
            // ".slick-slide.slick-current img",       // Slick 轮播（滑块模式）
            // ".slick-active img",                    // Slick 轮播（活动项）
            ".swiper-slide-active img",            // Swiper 轮播
            ".slick-slide.slick-current img",       // Slick 轮播（滑块模式）
            ".slick-active img",                    // Slick 轮播（活动项）
            ".image-list [aria-hidden='false'] img", // aria 方式标记隐藏项
            ".image-item.active img",               // 通用 active 标记
            ".image-item.is-active img",            // 通用 is-active 标记
            ".image-wrapper.active img",            // 图片包裹器 active
            ".carousel__item--active img",          // BEM 命名轮播
            ".viewer .active img",                  // 图片查看器
            "[aria-hidden='false'] img",            // 通用 aria 标记
            ".active img",                          // 通用 active 兜底
            ".current img",                         // 通用 current 兜底
            ".image-item img",                      // 仅限图片列表中的图
            ".carousel img"                         // 仅限轮播容器中的图

        ];

        for (const selector of selectors) {
            const image = document.querySelector(selector);
            if (image && isElementVisible(image)) {
                return image;
            }
        }

        return null;
    }

    /**
     * 备用方案：遍历所有 <img> 找到在当前活跃轮播项中的图片。
     * 当 findCurrentCarouselImage 的选择器未命中时使用。
     * @returns {HTMLImageElement|null}
     */
    function findCurrentImageInCarouselGroup() {
        const images = Array.from(document.querySelectorAll("img"))
            .filter((image) => isElementVisible(image) && isCurrentImageCandidate(image));

        return images[0] || null;
    }

    /**
     * 兜底方案：遍历所有 <img> 标签，返回可见面积最大的图片。
     * @returns {HTMLImageElement|null}
     */
    function findVisibleImage() {
        const images = Array.from(document.querySelectorAll("img"));
        let bestImage = null;
        let maxArea = 0;

        for (const image of images) {
            if (!isElementVisible(image)) {
                continue;
            }

            const rect = image.getBoundingClientRect();
            const visibleArea = getVisibleRectArea(rect);
            if (visibleArea > maxArea) {
                maxArea = visibleArea;
                bestImage = image;
            }
        }

        return bestImage;
    }

    function resolveInstagramScope(root = document) {
        if (!(root instanceof Element || root instanceof Document)) {
            return document;
        }

        return (
            root.querySelector('div[role="dialog"] article') ||
            root.querySelector('div[role="dialog"]') ||
            root.querySelector("main article") ||
            root.querySelector("article") ||
            root
        );
    }

    function scoreInstagramMediaCandidate(node, index = 0) {
        if (!(node instanceof HTMLImageElement || node instanceof HTMLVideoElement)) {
            return null;
        }

        const style = window.getComputedStyle(node);
        if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity || "1") === 0
        ) {
            return null;
        }

        const rect = node.getBoundingClientRect();
        const rectArea = rect.width * rect.height;
        const visibleArea = getVisibleRectArea(rect);
        if (rect.width < 60 || rect.height < 60 || visibleArea < 2500) {
            return null;
        }

        const sourceUrl = node instanceof HTMLVideoElement
            ? (node.currentSrc || node.src || node.getAttribute("poster") || "")
            : (node.currentSrc || node.src || "");
        if (!sourceUrl) {
            return null;
        }

        const inHeader = !!node.closest("header");
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const viewportCenterX = window.innerWidth / 2;
        const viewportCenterY = window.innerHeight / 2;
        const distanceToCenter = Math.hypot(centerX - viewportCenterX, centerY - viewportCenterY);
        const sizeBonus = Math.min(rectArea, 500000);
        const score =
            visibleArea * 10 +
            sizeBonus -
            distanceToCenter * 20 -
            (inHeader ? 500000 : 0) -
            index;

        return {
            node,
            index,
            rectArea,
            visibleArea,
            sourceUrl,
            isVideo: node instanceof HTMLVideoElement,
            score
        };
    }

    function findInstagramMediaByPointProbe(root = document) {
        const scope = resolveInstagramScope(root);
        const points = [
            [window.innerWidth / 2, window.innerHeight / 2],
            [window.innerWidth / 3, window.innerHeight / 2],
            [window.innerWidth * 2 / 3, window.innerHeight / 2],
            [window.innerWidth / 2, window.innerHeight / 3],
            [window.innerWidth / 2, window.innerHeight * 2 / 3]
        ];

        const candidates = [];
        for (const [x, y] of points) {
            const hit = document.elementFromPoint(Math.round(x), Math.round(y));
            const media = getClosestMediaElement(hit);
            if (!media || !(scope === document || scope.contains(media))) {
                continue;
            }
            const scored = scoreInstagramMediaCandidate(media, 0);
            if (scored) {
                candidates.push(scored);
            }
        }

        return candidates.sort((a, b) => b.score - a.score)[0] || null;
    }

    function pickInstagramCurrentMedia(root = document) {
        const scope = resolveInstagramScope(root);
        const nodes = Array.from(scope.querySelectorAll("img, video"));
        const visibleCandidates = nodes
            .map((node, index) => scoreInstagramMediaCandidate(node, index))
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);

        if (visibleCandidates[0]) {
            return visibleCandidates[0];
        }

        const probeHit = findInstagramMediaByPointProbe(scope);
        if (probeHit) {
            return probeHit;
        }

        const globalFallback = Array.from(document.querySelectorAll("img, video"))
            .map((node, index) => scoreInstagramMediaCandidate(node, index))
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);

        return globalFallback[0] || null;
    }

    /**
     * 综合图片查找策略（核心入口）：
     * 1. 优先从轮播组件中找当前图片
     * 2. 五点探测法：在视口中心及四等分点用 elementFromPoint 探测图片
     * 3. 全量遍历兜底
     *
     * 五点探测法的作用：对于非轮播但页面有多个图片的场景，
     * 取用户视线最可能关注的区域（中心 + 四角中间点）下的图片。
     * @returns {HTMLImageElement|null}
     */
    function findCurrentVisibleImage() {
        if (isInstagramHost()) {
            const media = pickInstagramCurrentMedia();
            return media && media.node instanceof HTMLImageElement ? media.node : null;
        }

        // === 第一优先级：轮播组件 ===
        const currentCarouselImage = findCurrentCarouselImage() || findCurrentImageInCarouselGroup();
        if (currentCarouselImage) {
            return currentCarouselImage;
        }

        // === 第二优先级：五点探测法 ===
        // 定义 5 个探测点：视口中心 + 四条边中点
        const points = [
            [window.innerWidth / 2, window.innerHeight / 2],          // 正中心
            [window.innerWidth / 4, window.innerHeight / 2],          // 左中
            [window.innerWidth * 0.75, window.innerHeight / 2],       // 右中
            [window.innerWidth / 2, window.innerHeight / 4],          // 上中
            [window.innerWidth / 2, window.innerHeight * 0.75]        // 下中
        ];

        const candidates = new Map(); // image → visibleArea

        for (const [x, y] of points) {
            const element = document.elementFromPoint(Math.round(x), Math.round(y));
            const image = getClosestImageElement(element);
            if (!image || !isElementVisible(image)) {
                continue;
            }

            const rect = image.getBoundingClientRect();
            candidates.set(image, getVisibleRectArea(rect));
        }

        if (candidates.size > 0) {
            // 如果探测到的图片中有属于活跃轮播项的，优先用（二次确认）
            const activeImage = Array.from(candidates.keys()).find(isCurrentImageCandidate);
            if (activeImage) {
                return activeImage;
            }

            // 否则返回可视面积最大的
            return Array.from(candidates.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        }

        // === 第三优先级：全量遍历 ===
        return findVisibleImage();
    }

    /**
     * 查找当前页面上最合适的媒体元素（视频优先，无视频则找图片）。
     * 这是对外暴露的统一媒体查找入口。
     * @returns {HTMLVideoElement|HTMLImageElement|null}
     */
    function findVisibleMediaElement() {
        if (isInstagramHost()) {
            return pickInstagramCurrentMedia()?.node || null;
        }

        // console.log("$$$$$$常规查找视频或图片");
        return  findVisibleVideo() || findCurrentVisibleImage();
    }

    // ============================================================
    // 上下文定位 — 找到媒体所属的抖音 feed 容器
    // ============================================================

    /**
     * 根据媒体节点向上查找其所在的抖音 feed 容器。
     * 抖音的 feed 容器有特定的 data-e2e 属性，用于限定元数据提取的范围，
     * 避免误取其他视频的信息。
     *
     * @param {Element} node - 视频或图片元素
     * @returns {Element} 找到的容器，兜底返回 document
     */
    function findMediaContext(node) {
        if (!node) {
            return document;
        }

        return (
            node.closest("[data-e2e='feed-active-video']") ||  // 当前活跃视频（播放中的）
            node.closest("[data-e2e='feed-video']") ||         // feed 列表中的视频
            node.closest("#sliderVideo") ||                    // 滑块中的视频
            node.closest("[data-e2e='feed-item']") ||          // 通用 feed 项
            document                                           // 兜底
        );
    }

    // ============================================================
    // 媒体捕获 — 将视频帧或图片转为 base64 数据
    // ============================================================

    /**
     * 将视频当前帧绘制到 Canvas 上，导出为 base64 PNG。
     * 使用视频的原始分辨率（videoWidth/videoHeight）确保画质。
     * @param {HTMLVideoElement} [video=findVisibleVideo()]
     * @returns {{ width: number, height: number, dataUrl: string }}
     */
    function captureVideoFrameAsDataUrl(video = findVisibleVideo()) {
        if (!video) {
            throw new Error("No visible video with ready frame data found.");
        }

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Failed to create canvas 2D context.");
        }

        // 将视频当前帧绘制到 canvas 上
        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        // const dataUrl = canvas.toDataURL("image/png");
        // 剪裁黑边
        const dataUrl = autoCropImageFromCanvas(canvas);

        if (!dataUrl.startsWith("data:image/png;base64,")) {
            throw new Error("Failed to convert video frame to base64 PNG.");
        }

        return {
            width: canvas.width,
            height: canvas.height,
            dataUrl
        };
    }

    /**
     * 将图片绘制到 Canvas 上，导出为 base64 PNG。
     *
     * 跨域图片（crossOrigin）使用 Canvas 的 toDataURL 会抛出安全错误，
     * 此时回退使用图片的 currentSrc（或 src）作为 dataUrl。
     * 虽然回退方案的 dataUrl 实际上是 URL 而非 base64，
     * 但 Eagle 端能识别并自行下载。
     *
     * @param {HTMLImageElement} [image=findVisibleImage()]
     * @returns {{ width: number, height: number, dataUrl: string }}
     */
    function captureImageAsDataUrl(image = findVisibleImage()) {
        if (!image) {
            throw new Error("No visible image found.");
        }

        const canvas = document.createElement("canvas");
        // 优先使用自然尺寸（原始分辨率），其次使用 CSS 尺寸
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;

        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Failed to create canvas 2D context.");
        }

        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        try {
            //const dataUrl = canvas.toDataURL("image/png");
            // 剪裁黑边
            const dataUrl = autoCropImageFromCanvas(canvas);

            if (!dataUrl.startsWith("data:image/png;base64,")) {
                throw new Error("Failed to convert image to base64 PNG.");
            }

            return {
                width: canvas.width,
                height: canvas.height,
                dataUrl
            };
        } catch (error) {
            // 跨域图片无法 toDataURL，回退使用图片 URL
            return {
                width: canvas.width,
                height: canvas.height,
                dataUrl: image.currentSrc || image.src || ""
            };
        }
    }

    // ============================================================
    // 元数据提取 — 从抖音 DOM 中获取标题、标签、作者链接
    // ============================================================

    /**
     * 从抖音的 DOM 结构中提取媒体元数据。
     * 依赖抖音的 data-e2e 测试属性选择器来定位元素。
     *
     * 提取规则：
     * - 标题：视频描述文本（优先精确选择器 → 宽松选择器），拼接时间戳
     * - 标签：作者昵称 + 描述中的 #话题标签 + "抖音"
     * - 作者 URL：头像链接的 href
     *
     * @param {Element} node - 视频或图片元素
     * @returns {{ title: string, tags: string[], authorUrl: string }}
     */
    function extractDouyinMeta(node) {
        // 先找媒体所在的 feed 容器，限定查询范围
        const context = findMediaContext(node);

        // --- 定位 DOM 元素 ---
        // 作者昵称元素
        const nicknameElement = context.querySelector("[data-e2e='feed-video-nickname']");
        // 视频描述元素
        const descElement = context.querySelector("[data-e2e='video-desc']");
        // 作者头像链接
        const avatarLink =
            context.querySelector("a[data-e2e='video-avatar']") ||
            nicknameElement?.closest("a[href]");

        // --- 提取作者昵称作为第一个标签 ---
        const authorTag = extractTextWithoutImages(nicknameElement);

        // --- 提取视频描述作为标题 ---
        // 优先使用描述中更精确的 span 文本，逐级降级
        const titleText = [
            descElement?.querySelector(".rMYszzqY > span"),  // 最精确的描述文本容器
            descElement?.querySelector(".rMYszzqY"),         // 描述容器
            descElement                                       // 完整描述
        ].map((element) => extractPlainText(element)).find(Boolean) || "";

        // --- 提取 #话题标签 ---
        // 描述中的 <a><span>#标签</span></a> 结构
        const hashtagTags = Array.from(descElement?.querySelectorAll("a span") || [])
            .map((node) => node.textContent?.replace(/\s+/g, " ").trim())
            .filter((text) => text && text.startsWith("#"));

        // --- 组装结果 ---
        const tags = unique([authorTag, ...hashtagTags]);
        const authorUrl = normalizeUrl(avatarLink?.getAttribute("href") || location.href);
        const finalTitle = trimToLength(
            `${titleText || document.title || "douyin-media"}-${formatCurrentTimeToSecond()}`,
            65
        );

        return {
            title: finalTitle,
            tags,
            authorUrl
        };
    }

    function extractInstagramMeta(node) {
        const article =
            node?.closest("article") ||
            document.querySelector('div[role="dialog"] article') ||
            document.querySelector("main article") ||
            document.querySelector("article");

        const authorLink = article?.querySelector("header a[href^='/']");
        const authorName = trimToLength(
            authorLink?.getAttribute("href")?.replace(/^\/|\/$/g, "").split("/")[0] || "",
            32
        );
        const captionRoot =
            article?.querySelector("h1") ||
            article?.querySelector("ul li h1") ||
            article?.querySelector("article span[dir='auto']");
        const captionText = extractPlainText(captionRoot);
        const hashtagTags = unique(
            (captionText.match(/#[\p{L}\p{N}_]+/gu) || []).map((tag) => tag.slice(1))
        );
        const permalink =
            location.href.match(/^https?:\/\/[^?#]+/)?.[0] || location.href;
        const titleBase =
            trimToLength(captionText, 40) ||
            trimToLength(document.title, 40) ||
            "instagram-media";

        return {
            title: trimToLength(`${titleBase}-${formatCurrentTimeToSecond()}`, 65),
            tags: unique([authorName, ...hashtagTags, "instagram"]),
            authorUrl: normalizeUrl(authorLink?.getAttribute("href") || permalink)
        };
    }

    function extractMediaMeta(node) {
        return isInstagramHost() ? extractInstagramMeta(node) : extractDouyinMeta(node);
    }

    // ============================================================
    // Payload 组装 — 构造发送给 Eagle API 的数据
    // ============================================================

    /**
     * 将捕获的媒体数据和元数据组装成 Eagle API 请求的 payload。
     * @param {{ width: number, height: number, dataUrl: string }} frame - 捕获的图片数据
     * @param {{ title: string, tags: string[], authorUrl: string }} meta - 提取的元数据
     * @returns {{ title: string, url: string, src: string, folderID: string, tags: string[] }}
     */
    function buildPayload(frame, meta) {
        // 以下两个变量暂未使用，保留以供 Eagle 功能完善后启用
        // const metaDescription = document.querySelector('meta[name="description"]')?.content || "";
        // const metaKeywords = document.querySelector('meta[name="keywords"]')?.content || "";
        return {
            title: meta.title,                                    // 素材标题
            url: meta.authorUrl,                                   // 来源 URL（作者主页）
            src: frame.dataUrl,                                   // 图片数据（base64 或 URL）
            // folderID: "抖音",                                     // 存入 Eagle 的文件夹名称
            // tags: unique([...(meta.tags || []), "抖音"]),         // 自动添加 "抖音" 标签
            // ============================================================
            // 🚧 以下参数暂时不需要，等 Eagle 端功能完善后再加回来
            // ============================================================
            // metaAlt: "",
            // metaTitle: meta.title,
            // metaDescription,
            // metaKeywords,
            // metaTags: joinedTags,
            // forceOpenCollectModal: "",
            // forceHideCollectModal: ""
        };
    }

    /**
     * 将 payload 序列化为 application/x-www-form-urlencoded 格式。
     * @param {{ title: string, url: string, src: string, folderID: string, tags: string[] }} payload
     * @returns {string} 编码后的请求体字符串
     */
    function buildRequestBody(payload) {
        const params = new URLSearchParams();

        // params.set("version", SCRIPT_VERSION);       // 脚本版本
        params.set("type", "image");                 // 素材类型（固定为图片）
        params.set("title", trimToLength(payload.title, 65));  // 标题（Eagle 限制 65 字符）
        params.set("url", payload.url || "");         // 来源 URL
        params.set("src", payload.src || "");         // 图片数据源
        // params.set("folderID", payload.folderID || ""); // 目标文件夹
        // params.set("tags", payload.tags || "");       // 标签（数组转逗号分隔字符串）

        // ============================================================
        // 🚧 以下参数暂时不需要，等 Eagle 端功能完善后再加回来
        // ============================================================
        // params.set("metaAlt", payload.metaAlt || "");
        // params.set("metaTitle", trimToLength(payload.metaTitle, 65));
        // params.set("metaDescription", payload.metaDescription || "");
        // params.set("metaKeywords", payload.metaKeywords || "");
        // params.set("metaTags", payload.tags || "");
        // params.set("forceOpenCollectModal", payload.forceOpenCollectModal || "");
        // params.set("forceHideCollectModal", payload.forceHideCollectModal || "");

        return params.toString();
    }

    /**
     * 构建 Eagle API v2.0 的 JSON payload。
     * url 字段同时支持 http/https 地址和 base64 Data URL。
     */
    function buildPayloadV2(frame, meta) {
        return {
            url: frame.dataUrl,
            name: meta.title,
            website: meta.authorUrl,
            tags: meta.tags
        };
    }

    /**
     * 将 v2 payload 序列化为 JSON 字符串。
     */
    function buildRequestBodyV2(payload) {
        return JSON.stringify({
            url: payload.url,
            name: payload.name,
            website: payload.website,
            tags: payload.tags
        });
    }

    // ============================================================
    // Eagle API 请求 — 通过 GM_xmlhttpRequest 发送数据到 Eagle
    // ============================================================

    /**
     * 使用 API v1.0 将 payload 发送到 Eagle 本地 HTTP 服务。
     * @param {object} payload
     * @returns {Promise<object>}
     */
    function saveToEagleV1(payload) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: EAGLE_URL_V1,
                timeout: 20000,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
                },
                data: buildRequestBody(payload),
                onload(response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response);
                        return;
                    }
                    reject(new Error(`Eagle v1 returned unexpected status: ${response.status}`));
                },
                onerror() {
                    reject(new Error("Request to Eagle v1 failed. Ensure Eagle is running and localhost:41593 is available."));
                },
                ontimeout() {
                    reject(new Error("Request to Eagle v1 timed out."));
                }
            });
        });
    }

    /**
     * 使用 API v2.0 将 payload 发送到 Eagle 本地 HTTP 服务。
     * @param {object} payload
     * @returns {Promise<object>}
     */
    function saveToEagleV2(payload) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: EAGLE_URL_V2,
                timeout: 20000,
                headers: {
                    "Content-Type": "application/json; charset=UTF-8"
                },
                data: buildRequestBodyV2(payload),
                onload(response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response);
                        return;
                    }
                    reject(new Error(`Eagle v2 returned unexpected status: ${response.status}`));
                },
                onerror() {
                    reject(new Error("Request to Eagle v2 failed. Ensure Eagle is running and localhost:41595 is available."));
                },
                ontimeout() {
                    reject(new Error("Request to Eagle v2 timed out."));
                }
            });
        });
    }

    /**
     * 根据当前 API 版本设置发送 payload 到 Eagle。
     * v2 失败时自动回退到 v1。
     * @param {object} payload - v1 格式的 payload
     * @param {object} meta - 元数据
     * @returns {Promise<object>}
     */
    async function saveToEagle(payload, meta) {
        if (USE_API_V2) {
            const v2Payload = buildPayloadV2(
                { width: 0, height: 0, dataUrl: payload.src },
                { title: payload.title, tags: meta.tags, authorUrl: payload.url }
            );
            try {
                return await saveToEagleV2(v2Payload);
            } catch (v2Error) {
                console.warn("[Save Douyin Media To Eagle] v2.0 failed, falling back to v1.0:", v2Error.message);
            }
        }
        return saveToEagleV1(payload);
    }

    // ============================================================
    // 主流程 — 捕获 → 提取 → 保存
    // ============================================================

    /**
     * 完整处理流程：查找当前媒体 → 捕获图片数据 → 提取元数据 → 发送到 Eagle。
     * 这是整个脚本的核心编排函数。
     * @returns {Promise<object>} 成功时返回发送的 payload
     */
    async function captureAndSaveCurrentMedia() {
        // 步骤 1：找到当前可见的媒体元素（视频优先）
        const media = findVisibleMediaElement();

        if (!media) {
            throw new Error("No visible media found.");
        }

        // 步骤 2：根据媒体类型选择捕获方式
        const frame = media.tagName === "VIDEO"
            ? captureVideoFrameAsDataUrl(media)   // 视频 → 帧截图
            : captureImageAsDataUrl(media);       // 图片 → Canvas 导出

        // 步骤 3：从 DOM 提取标题、标签、作者 URL
        const meta = extractMediaMeta(media);

        // 步骤 4：组装 Eagle 请求 payload
        const payload = buildPayload(frame, meta);

        // 步骤 5：发送到 Eagle（根据 USE_API_V2 选择版本）
        await saveToEagle(payload, meta);
        return payload;
    }


    /**
     * 自动裁剪 Canvas 边缘的黑边
     * @param {HTMLCanvasElement} sourceCanvas - 源 Canvas 对象
     * @param {number} threshold - 亮度阈值，默认 30
     * @param {number} minPixelRate - 有效像素占比阈值，默认 0.05
     * @returns {string} 返回裁剪后的 Base64 字符串
     */
    function autoCropImageFromCanvas(sourceCanvas, threshold = 30, minPixelRate = 0.1) {
        const ctx = sourceCanvas.getContext('2d');
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;

        // 直接从传入的 Canvas 获取整张图像的像素数据
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        // 默认边界初始值
        let top = 0, bottom = h - 1, left = 0, right = w - 1;

        // 1. 从上往下扫描，找上边界
        for (let y = 0; y < h; y++) {
            let activePixels = 0;
            for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 4;
                const brightness = 0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2];
                if (brightness > threshold) activePixels++;
            }
            if (activePixels > w * minPixelRate) {
                top = y;
                break;
            }
        }

        // 2. 从下往上扫描，找下边界
        for (let y = h - 1; y >= 0; y--) {
            let activePixels = 0;
            for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 4;
                const brightness = 0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2];
                if (brightness > threshold) activePixels++;
            }
            if (activePixels > w * minPixelRate) {
                bottom = y;
                break;
            }
        }

        // 3. 从左往右扫描，找左边界
        for (let x = 0; x < w; x++) {
            let activePixels = 0;
            for (let y = top; y <= bottom; y++) {
                const idx = (y * w + x) * 4;
                const brightness = 0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2];
                if (brightness > threshold) activePixels++;
            }
            if (activePixels > (bottom - top) * minPixelRate) {
                left = x;
                break;
            }
        }

        // 4. 从右往左扫描，找右边界
        for (let x = w - 1; x >= 0; x--) {
            let activePixels = 0;
            for (let y = top; y <= bottom; y++) {
                const idx = (y * w + x) * 4;
                const brightness = 0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2];
                if (brightness > threshold) activePixels++;
            }
            if (activePixels > (bottom - top) * minPixelRate) {
                right = x;
                break;
            }
        }

        // 计算裁剪后的实际宽高
        const cropWidth = right - left + 1;
        const cropHeight = bottom - top + 1;

        // 创建一个新的 Canvas 用于输出裁剪后的图像
        const resultCanvas = document.createElement('canvas');
        resultCanvas.width = cropWidth;
        resultCanvas.height = cropHeight;
        const resultCtx = resultCanvas.getContext('2d');

        // 核心：直接把传入的源 Canvas 中确定的主体区域，绘制到新 Canvas 上
        resultCtx.drawImage(sourceCanvas, left, top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

        // 如果你需要直接拿到新 Canvas 对象，可以将下面这行改为：return resultCanvas;
        return resultCanvas.toDataURL('image/png');
    }


    /**
     * 入口函数：执行完整流程，将结果输出到控制台。
     * 捕捉所有异常避免未捕获的 Promise 拒绝。
     */
    async function run() {
        try {
            const payload = await captureAndSaveCurrentMedia();
            console.log("[Save Douyin Media To Eagle] Saved:", payload);
        } catch (error) {
            console.error("[Save Douyin Media To Eagle]", error);
        }
    }

    // ============================================================
    // 键盘事件 — 快捷键触发保存
    // ============================================================

    /**
     * 键盘按下事件处理器。
     * - 跳过编辑状态（input/textarea/contentEditable），避免干扰用户输入
     * - 匹配快捷键后阻止默认行为并执行保存
     *
     * @param {KeyboardEvent} event
     */
    async function onKeydown(event) {
        const active = document.activeElement;
        const editing =
            active &&
            (active.tagName === "INPUT" ||
                active.tagName === "TEXTAREA" ||
                active.isContentEditable);

        // 正在输入时忽略快捷键
        if (editing) {
            return;
        }

        // 不匹配快捷键时忽略
        if (event.key.toLowerCase() !== HOTKEY) {
            return;
        }

        event.preventDefault();
        await run();
    }

    // ============================================================
    // 初始化 — 注册事件和菜单
    // ============================================================

    /**
     * 切换 Eagle API 版本（v1 ↔ v2），并刷新菜单显示。
     */
    function toggleApiVersion() {
        USE_API_V2 = !USE_API_V2;
        const label = USE_API_V2 ? "v2.0" : "v1.0";
        console.log(`[Save Douyin Media To Eagle] Switched to API ${label}`);
        // 重新注册菜单以反映当前状态
        registerMenuCommands();
    }

    /**
     * 注册 Tampermonkey 菜单命令。
     * 反复调用时会先移除已有命令再重新注册，保证菜单项反映最新状态。
     */
    function registerMenuCommands() {
        const versionLabel = USE_API_V2 ? "v2.0" : "v1.0";
        // 先移除旧的，避免重复
        GM_registerMenuCommand(`保存当前媒体到 Eagle (API ${versionLabel})`, run);
        GM_registerMenuCommand(`切换 Eagle API 版本 (当前: ${versionLabel})`, toggleApiVersion);
    }

    // 先移除旧监听器再注册，防止脚本重复注入时产生多个绑定
    document.removeEventListener("keydown", onKeydown);
    document.addEventListener("keydown", onKeydown);

    // 注册 Tampermonkey 菜单命令
    registerMenuCommands();

    // 暴露到全局，方便在开发者工具中手动调用
    window.saveVisibleDouyinMediaToEagle = run;
    window.toggleEagleApiVersion = toggleApiVersion;
})();
