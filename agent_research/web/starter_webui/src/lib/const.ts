// ECS 部署配置：
// 1. 开发/本地：保持默认，自动使用 window.location.hostname:8090
// 2. 生产/ECS：启动前设置环境变量 export NEXT_PUBLIC_API_URL=http://<公网IP>:8090
//    然后重新构建: npm run build

const getEndpoint = (): string => {
  // 服务端渲染时使用环境变量
  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }

  // 客户端渲染时根据当前页面地址推断
  if (typeof window !== 'undefined') {
    // 如果页面是通过公网IP访问的，就用同一个IP访问后端
    return `${window.location.protocol}//${window.location.hostname}:8090`;
  }

  // 默认回退
  return 'http://localhost:8090';
};

export const ENDPOINT = getEndpoint();
