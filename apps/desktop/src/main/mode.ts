/** Pure run-mode resolution (no electron imports). */
export interface Mode {
  production: boolean;
  fixture: boolean;
  voiceTestWindow: boolean;
  devServer: boolean;
  devLogging: boolean;
}

export function resolveMode(env: Record<string, string | undefined>, isPackaged: boolean): Mode {
  const production = env.POINTY_MODE === "production";
  if (production) {
    return {
      production,
      fixture: false,
      voiceTestWindow: false,
      devServer: env.POINTY_DEV_SERVER === "1",
      devLogging: false,
    };
  }
  return {
    production,
    fixture: env.POINTY_NO_FIXTURE !== "1",
    voiceTestWindow: env.POINTY_VOICE === "1",
    devServer: !isPackaged,
    devLogging: !isPackaged,
  };
}
