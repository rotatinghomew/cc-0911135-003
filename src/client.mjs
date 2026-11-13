export async function inspect(base) {
  const response = await fetch(base);
  return { status: response.status, title: /<title>(.*?)<\/title>/.exec(await response.text())?.[1],
    interaction: '使用浏览器登录并选择筛选条件' };
}
