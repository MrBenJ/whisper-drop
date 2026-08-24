type BeforePackContext = {
  arch: number
  electronPlatformName: NodeJS.Platform
  packager: {
    projectDir: string
  }
}

export default function verifyBeforePack(context: BeforePackContext): Promise<void>
