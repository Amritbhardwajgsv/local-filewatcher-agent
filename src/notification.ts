import { execFile } from 'child_process';

export function showinvalidfilewarning(
  filename: string,
  allowedExtensions: string[],
): void {
  showWarning(
    filename,
    `Please add only: ${allowedExtensions.join(', ')}`,
    'Wrong File Type',
  );
}

export function showFileSizeWarning(
  filename: string,
  maxFileSizeMb: number,
): void {
  showWarning(
    filename,
    `The maximum allowed file size is ${maxFileSizeMb} MB.`,
    'File Too Large',
  );
}

function showWarning(
  filename: string,
  detail: string,
  title: string,
): void {
  if (process.platform !== 'win32') {
    return;
  }

  const message = [
    `"${filename}" is not an accepted file.`,
    '',
    detail,
  ].join('\n');

  const script = [
    'Add-Type -AssemblyName PresentationFramework',
    `[System.Windows.MessageBox]::Show($env:TENDER_AGENT_WARNING, 'Tender Agent - ${title}', 'OK', 'Warning') | Out-Null`,
  ].join('; ');

  execFile(
    'powershell.exe',
    ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script],
    {
      windowsHide: true,
      env: {
        ...process.env,
        TENDER_AGENT_WARNING: message,
      },
    },
    (error) => {
      if (error) {
        // getLogger may be defined elsewhere in the project
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).getLogger?.()?.warn?.('Could not display invalid file warning', {
          event: 'notification_failed',
          file: filename,
          error: error.message,
        });
      }
    },
  );
}
