declare module "*.png" {
  const value: { src: string; height: number; width: number };
  export default value;
}