# 前端代码规范

| 版本 | 编写人 | 编写日期   | 说明 |
| ---- | ------ | ---------- | ---- |
| 1.0  | 董玉倩 | 2022.12.06 |      |

## 1. 命名规范

**【项目命名】**：小写方式，以中划线分隔

> 正确示例：kibo-swift-cloud-admin-frontend-v2021

**【目录命名】**：小写方式， 以中划线分隔

> 正确示例：scripts / styles / api / components / assets / fonts / utils / error-page

**【vue组件命名、组件文件名】**：大驼峰方式

> 正确示例：CountTo / Loading / Scroll / WaterBall

**【JS、CSS、SCSS、HTML、VUE、PNG 文件命名】**：小写方式， 以中划线分隔

> 正确示例：render-dom.js / error-log.css / mapper.html / index.vue / company-logo.png

**【变量、对象、函数、方法、参数】**：小驼峰方式，其中方法命名必须是 动词+名词 形式

> 正确示例：userRankLoading / statisticsList / getHttpMessage()

**【类class、接口interface、构造函数】**：大驼峰方式

> 正确示例：
>
> ```typescript
> class User {
>   constructor(options) {
>     this.name = options.name;
>   }
> }
> 
> const good = new User({
>   name: 'yup',
> });
> 
> interface IPerson { 
>     firstName:string, 
>     lastName:string, 
>     sayHi: ()=>string 
> } 
> ```

**【常量名】**：全部大写，单词间用下划线隔开，不要缩写，力求语义清楚

> 正确示例： MAX_STOCK_COUNT
>
> 错误示例： MAX_COUNT

**【CSS命名】**：class名小写方式， 以中划线分隔；id小驼峰方式

## 2. 命名严谨性

- 使用英文命名，严禁使用中文命名或拼音与英文混合的命名。

  > 正确示例：network.js / order.css
  >
  > 错误示例：pingfen.vue / guoqiUser

- 命名应该语义化，英文拼写和语法可以让阅读者易于理解，避免歧义。

  > 正确示例：changeBusiness / getUserList

- 英文要拼写正确，使用常见缩写，杜绝完全不规范的缩写，避免望文不知义。

  > 正确示范：rmb / btns
  >
  > 错误示例：AbstractClass 缩写成AbsClass / condition缩写成condi

## 3. 编程规约

**【CSS选择器中避免使用标签名】**

> 错误示范：
>
> ```css
> div {
>   font-size: 2rem;
> }
> ```

**【CSS中省略 0 后面的单位】**

> 正确示范：
>
> ```css
> div {
>   padding-bottom: 0; 
> }
> ```
>
> 错误示范：
>
> ```css
> div {
>   padding-bottom: 0px; 
> }
> ```

**【关键字后必须有大括号】**：if, else, for, while, do, switch, try, catch, finally, with

> 正确示范：
>
> ```js
> if (condition) { 
>   doSomething();
> }
> ```
>
> 错误示范：
>
> ```js
> if (condition) doSomething();
> ```

**【及时删除无用代码】**：一些调试的 console 语句；无用的弃用功能代码

**【禁止使用】**：禁止使用 alert、debugger、eval

**【添加必要的注释】**

- 公共组件使用说明
- api 目录的接口 js 文件必须加注释
- store 中的 state、mutation、action 等必须加注释
- vue 文件的 methods，每个 method 必须添加注释
- vue 文件的 data，非常见单词要加注释

## 4. Vue 项目规范

**【Prop 定义尽量详细】**

- 必须使用小驼峰命名

- 必须指定类型

- 必须加上注释，表明其含义

- 必须加上 default

> 正例：
>
> ```js
>  props: {
>   // 组件状态，用于控制组件的颜色
>    status: {
>      type: String,
>      required: true,
> 		 default: "1",
>      validator: function (value) {
>        return [
>          'succ',
>          'info',
>          'error'
>        ].indexOf(value) !== -1
>      }
>    },
>     // 用户级别，用于显示皇冠个数
>    userLevel：{
>       type: String,
>       required: true
>    }
> }
> ```
>
> 

【**为组件样式设置作用域**】

> 正例：
>
> ```vue
> <template>
>   <button class="btn btn-close">X</button>
> </template>
> <!-- 使用 `scoped` 特性 -->
> <style scoped>
>   .btn-close {
>     background-color: red;
>   }
> </style>
> ```
>
> 

【**模板中使用简单的表达式**】

> 正例：
>
> ```vue
> <template>
>   <p>{{ normalizedFullName }}</p>
> </template>
> // 复杂表达式已经移入一个计算属性
> computed: {
>   normalizedFullName: function () {
>     return this.fullName.split(' ').map(function (word) {
>       return word[0].toUpperCase() + word.slice(1)
>     }).join(' ')
>   }
> }
> ```
>
> 反例：
>
> ```vue
> <template>
>   <p>
>        {{
>           fullName.split(' ').map(function (word) {
>              return word[0].toUpperCase() + word.slice(1)
>            }).join(' ')
>         }}
>   </p>
> </template>
> ```
>
> 

**【script 标签内部结构顺序】**：components > props > data > computed > watch > filter > 钩子函数（钩子函数按其执行顺序） > methods