# 快速开始
## 安装
通过 Bun 安装：
```bash
bun add klinecharts @klinecharts/pro
```
## 使用
### 第一步，创建容器
```html
<div id="container"></div>
```
### 第二步，创建实例
在使用 Bun 的项目中
```javascript
// 引入js
import { KLineChartPro, DefaultDatafeed } from '@klinecharts/pro'
// 引入样式
import '@klinecharts/pro/style.css'

// 创建实例
const chart = new KLineChartPro({
  container: document.getElementById('container'),
  // 初始化标的信息
  symbol: {
    exchange: 'XNYS',
    market: 'stocks',
    name: 'Alibaba Group Holding Limited American Depositary Shares, each represents eight Ordinary Shares',
    shortName: 'BABA',
    ticker: 'BABA',
    priceCurrency: 'usd',
    type: 'ADRC',
  },
  // 初始化周期
  period: { multiplier: 15, timespan: 'minute', text: '15m' },
  // 这里使用默认的数据接入，如果实际使用中也使用默认数据，需要去 https://polygon.io/ 申请 API key
  datafeed: new DefaultDatafeed(`${polygonIoApiKey}`)
})
```

第一个图表就创建完成了
