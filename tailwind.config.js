/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /*
         * 设计取向：「深夜书房」——不做 Linear 一类的通用暗色工具（旧品牌色
         * #5E6AD2 就是 Linear 的紫，一眼「SaaS 后台」），而是学术世界的材料。
         *
         * 底色族取香港中文大学的校色「紫」（Pantone 255C / #750F6D）压暗成
         * 酒梅色墨：紫象征热诚与忠耿，配象牙纸的文字。层级仍然靠 hairline
         * 边框 + 顶部内高光，不靠大色差。
         *
         * 品牌金同出中大校色「金」（Pantone 117C / #DDA300），降一档饱和用
         * 作烫金——「紫与金」是中大校徽本身的配色（紫底金凤），整个系统
         * 的依据由此而来。
         *
         * 底色保留紫的色相、饱和度压低一半：大面积高饱和的酒梅色会让象牙字
         * 发灰发脏，紫意只需「看得出来」。sunken 给侧栏——导航退后、
         * 内容区更亮，视线自然落在正在读的那篇上。
         */
        bg: {
          sunken: '#110C11',
          base: '#171217',
          raised: '#1F1920',
          overlay: '#282129',
          hover: '#322A33'
        },
        ink: {
          /*
           * 象牙暖灰：纸的颜色，不是终端的颜色。
           * low 是 10–12px 辅助小字的颜色，在 base 上要 ≥ 4.5:1 才读得清。
           */
          high: '#EEEAE2',
          mid: '#B3AEA4',
          low: '#8A857B'
        },
        brand: {
          /*
           * 深松绿（紫的互补色，压成「松柏」而不是翠绿）：书签丝带、下划线、
           * 图标、主按钮。紫底配松绿是「紫藤配松柏」的互补搭配，克制在
           * 小面积才大气。主按钮从此是「绿底象牙字」。
           */
          DEFAULT: '#38735A',
          soft: '#74AC8F',
          mist: '#ABD3BC',
          deep: '#275543'
        },
        /* 中大紫本紫：只给校徽式 monogram 的底，别处不用 */
        cuhk: {
          DEFAULT: '#750F6D',
          deep: '#5E0F58'
        },
        accent: {
          /*
           * 淡紫银：中大紫提亮一档。原来是铜绿，品牌换成松绿之后两个绿会
           * 撞车，把辅色挪回紫家族（与底色同族的单色和声），专用于
           * 「已精读」、行内代码、年份分布条这类次级标记。
           */
          DEFAULT: '#9C7AB1',
          soft: '#BFA6CE'
        },
        ok: '#63B874', // 苔绿（比品牌绿亮一档、偏黄，语义「完成」）
        warn: '#D2832F', // 琥珀
        danger: '#C4584D', // 茜红
        info: '#7FA3C7' // 钢青
      },
      fontFamily: {
        sans: ['-apple-system', 'PingFang SC', 'system-ui', 'sans-serif'],
        /*
         * 衬线栈：论文的内容面（标题、正文、数字）用衬线——论文本来就是
         * 衬线的，宋体也是中文出版正文的惯例。全部系统字体，不引远程资源
         * （CSP 只允许本地字体）：macOS 上 New York / 宋体（Songti SC）都是
         * 现成的，Windows 回落 Georgia / 中易宋体。
         * Georgia / New York 的数字是 old-style（文字数字），统计页的数值
         * 会自带出版物质感。
         */
        serif: ['New York', 'Iowan Old Style', 'Georgia', 'Songti SC', 'STSong', 'SimSun', 'serif'],
        mono: ['SF Mono', 'JetBrains Mono', 'Menlo', 'monospace']
      },
      borderColor: {
        /* hairline 带一点紫调的暖白，和底色同一族 */
        line: 'rgba(240,234,242,0.09)',
        strong: 'rgba(240,234,242,0.18)'
      },
      /*
       * UI 骨架字号阶梯。只设字号、不带行高（继承 body 的 1.65），
       * 新代码用这几档，不要再写 text-[10.5px] 这类散值。
       */
      fontSize: {
        tiny: '10.5px',
        caption: '11.5px',
        meta: '12px',
        ui: '12.5px',
        body: '13.5px'
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'spin-slow': {
          to: { transform: 'rotate(360deg)' }
        }
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out',
        'slide-up': 'slide-up 220ms cubic-bezier(0.22,1,0.36,1)',
        'spin-slow': 'spin-slow 1.1s linear infinite'
      }
    }
  },
  plugins: [require('tailwindcss-animate')]
}
