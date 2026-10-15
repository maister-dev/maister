#include <sys/types.h>
#include <sys/wait.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static pid_t member_pid;

static void contain_member(void) {
  if (member_pid <= 0) return;
  if (kill(member_pid, SIGKILL) != 0 && errno != ESRCH) _exit(70);
  while (waitpid(member_pid, NULL, 0) < 0) {
    if (errno != EINTR) _exit(70);
  }
  member_pid = 0;
}

static void contain_on_signal(int received) {
  contain_member();
  _exit(128 + received);
}

int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "--member")) {
    int ready = atoi(argv[2]);
    if (setpgid(0, 0) != 0 || write(ready, "r", 1) != 1) return 70;
    close(ready);
    for (;;) pause();
  }
  if (argc != 3 || (strcmp(argv[2], "owned") && strcmp(argv[2], "inspector"))) return 64;
  if (signal(SIGALRM, contain_on_signal) == SIG_ERR ||
      signal(SIGTERM, contain_on_signal) == SIG_ERR ||
      signal(SIGINT, contain_on_signal) == SIG_ERR) return 70;
  alarm(15);
  int ready[2];
  if (pipe(ready) != 0) return 70;
  member_pid = fork();
  if (member_pid < 0) return 70;
  if (member_pid == 0) {
    close(ready[0]);
    char descriptor[32];
    snprintf(descriptor, sizeof(descriptor), "%d", ready[1]);
    if (setenv("MAISTER_TEST_WORKTREE_INVOCATION_ID", argv[1], 1) != 0 ||
        (!strcmp(argv[2], "inspector") && setenv("MAISTER_TEST_PROCESS_INSPECTOR", argv[1], 1) != 0)) _exit(70);
    execl(argv[0], argv[0], "--member", descriptor, NULL);
    _exit(70);
  }
  if (atexit(contain_member) != 0) { contain_member(); return 70; }
  close(ready[1]);
  char byte;
  if (read(ready[0], &byte, 1) != 1) return 70;
  close(ready[0]);
  printf("{\"event\":\"group-transition-ready\",\"pid\":%d}\n", member_pid);
  fflush(stdout);
  if (read(STDIN_FILENO, &byte, 1) != 1 || byte != 'z') return 70;
  if (kill(member_pid, SIGKILL) != 0) return 70;
  siginfo_t outcome;
  if (waitid(P_PID, (id_t)member_pid, &outcome, WEXITED | WNOWAIT) != 0 ||
      outcome.si_pid != member_pid || outcome.si_code != CLD_KILLED || outcome.si_status != SIGKILL) return 70;
  struct kinfo_proc identity;
  size_t length = sizeof(identity);
  int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, member_pid};
  if (sysctl(mib, 4, &identity, &length, NULL, 0) != 0 || length != sizeof(identity) ||
      identity.kp_proc.p_pid != member_pid || identity.kp_eproc.e_pgid != member_pid || identity.kp_proc.p_stat != SZOMB) return 70;
  printf("{\"event\":\"group-transition-zombie\",\"pid\":%d,\"status\":%d}\n", member_pid, identity.kp_proc.p_stat);
  fflush(stdout);
  if (read(STDIN_FILENO, &byte, 1) != 1 || byte != 'r') return 70;
  contain_member();
  return 0;
}
