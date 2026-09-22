import { fileIconKind, type FileIconKind } from "../../../lib/viewers/fileUtils";
import {
  BookIcon,
  FileCodeIcon,
  FileDataIcon,
  PageIcon,
  FileImageIcon,
  FileTerminalIcon,
  FileTextIcon,
  FolderIcon,
  type IconProps,
} from "./Icon";

const BY_KIND: Record<FileIconKind, (p: IconProps) => React.ReactElement> = {
  code: FileCodeIcon,
  text: FileTextIcon,
  data: FileDataIcon,
  book: BookIcon,
  image: FileImageIcon,
  script: FileTerminalIcon,
  file: PageIcon,
};

interface FileIconProps extends IconProps {
  /** Extension with its dot (`".py"`), as `FileEntry.extension` carries it. */
  ext: string | null;
  isDir?: boolean;
}

/**
 * The icon every file list shows beside an entry — tree, search, browser,
 * downloads, remote picker, TeX structure, project blob. Drawn, not emoji, so
 * it takes the row's colour (a dimmed "not on remote" row dims its icon too).
 */
export function FileIcon({ ext, isDir, ...rest }: FileIconProps) {
  if (isDir) return <FolderIcon {...rest} />;
  const Icon = BY_KIND[fileIconKind(ext)];
  return <Icon {...rest} />;
}
