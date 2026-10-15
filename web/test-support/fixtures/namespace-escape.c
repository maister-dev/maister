#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
  const int userns = unshare(CLONE_NEWUSER);
  const int userns_errno = userns == 0 ? 0 : errno;
  const int remount = mount(NULL, "/", NULL, MS_REMOUNT, NULL);
  const int remount_errno = remount == 0 ? 0 : errno;
  const int namespace_fd = open("/proc/1/ns/mnt", O_RDONLY | O_CLOEXEC);
  if (namespace_fd == -1) { perror("open namespace"); return 1; }
  const int reentry = setns(namespace_fd, CLONE_NEWNS);
  const int reentry_errno = reentry == 0 ? 0 : errno;
  close(namespace_fd);
  char status_path[64];
  snprintf(status_path, sizeof(status_path), "/proc/%d/stat", getppid());
  FILE *status = fopen(status_path, "r");
  char buffer[4096];
  if (!status || !fgets(buffer, sizeof(buffer), status)) { perror("read application ancestry"); return 1; }
  fclose(status);
  char state;
  int bridge_pid;
  const char *fields = strrchr(buffer, ')');
  if (!fields || sscanf(fields + 2, "%c %d", &state, &bridge_pid) != 2 || bridge_pid < 2) { fputs("invalid bridge ancestry\n", stderr); return 1; }
  const int pidfd = syscall(SYS_pidfd_open, bridge_pid, 0);
  if (pidfd == -1) { perror("open bridge pidfd"); return 1; }
  const int descriptor = syscall(SYS_pidfd_getfd, pidfd, 1, 0);
  const int descriptor_errno = descriptor == -1 ? errno : 0;
  if (descriptor != -1) close(descriptor);
  close(pidfd);
  const int attach = ptrace(PTRACE_ATTACH, bridge_pid, NULL, NULL);
  const int attach_errno = attach == -1 ? errno : 0;
  if (attach != -1) {
    int child_status;
    if (waitpid(bridge_pid, &child_status, 0) == -1 || ptrace(PTRACE_DETACH, bridge_pid, NULL, NULL) == -1) { perror("release bridge inspection control"); return 1; }
  }
  printf("{\"userns\":%d,\"remount\":%d,\"reentry\":%d,\"bridgeDescriptor\":%d,\"bridgePtrace\":%d}\n", userns_errno, remount_errno, reentry_errno, descriptor_errno, attach_errno);
  return 0;
}
