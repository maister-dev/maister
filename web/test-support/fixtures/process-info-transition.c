#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int scheduled_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize);
static int scheduled_proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int buffersize);

/* Scheduling and catalogue failure are interposed; identity and tags remain kernel reads. */
#define main native_reader_main
#define proc_pidinfo scheduled_proc_pidinfo
#define proc_listpids scheduled_proc_listpids
#include "../process-environment.c"
#undef proc_listpids
#undef proc_pidinfo
#undef main

static pid_t target_pid;
static int release_fd;
static unsigned int info_reads;
static unsigned int first_status;
static unsigned int second_status;
static int release_after_first_info;
static int deny_catalogue;
static unsigned int catalogue_calls;
static int child_released;

enum transition_control {
  CONTROL_STATUS,
  CONTROL_ENVIRONMENT,
  CONTROL_SELECTED_CATALOGUE,
  CONTROL_SNAPSHOT_CATALOGUE,
  CONTROL_SELECTED_INSPECTOR,
  CONTROL_SNAPSHOT_INSPECTOR
};

static const char *const control_names[] = {
  "status", "environment", "selected-catalogue", "snapshot-catalogue",
  "selected-inspector", "snapshot-inspector"
};

static int scheduled_proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int buffersize) {
  catalogue_calls++;
  if (deny_catalogue) {
    errno = EPERM;
    return 0;
  }
  int result = proc_listpids(type, typeinfo, buffer, buffersize);
  if (buffer && result > 0) {
    pid_t *pids = buffer;
    size_t count = (size_t)(result < buffersize ? result : buffersize) / sizeof(pid_t);
    /* Preserve the real snapshot, scheduling the target before bounded diagnostics fill. */
    for (size_t index = 0; index < count; index++) {
      if (pids[index] == target_pid) {
        pid_t first = pids[0];
        pids[0] = pids[index];
        pids[index] = first;
        break;
      }
    }
  }
  return result;
}

static void contain_child(void) {
  if (target_pid <= 0) return;
  if (kill(target_pid, SIGKILL) != 0 && errno != ESRCH) {
    perror("native transition containment signal");
    _exit(70);
  }
  while (waitpid(target_pid, NULL, 0) < 0) {
    if (errno == EINTR) continue;
    perror("native transition containment wait");
    _exit(70);
  }
  target_pid = 0;
}

static void contain_on_signal(int received) {
  if (target_pid > 0) kill(target_pid, SIGKILL);
  _exit(128 + received);
}

static void release_child(void) {
  char release = 'x';
  siginfo_t outcome;
  if (write(release_fd, &release, 1) != 1 ||
      waitid(P_PID, (id_t)target_pid, &outcome, (release_after_first_info ? WEXITED : WSTOPPED) | WNOWAIT) != 0 ||
      outcome.si_pid != target_pid ||
      outcome.si_code != (release_after_first_info ? CLD_EXITED : CLD_STOPPED) ||
      outcome.si_status != (release_after_first_info ? 0 : SIGSTOP)) {
    perror("native transition child outcome");
    exit(70);
  }
  child_released = 1;
}

static int scheduled_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize) {
  if (pid == target_pid) {
    info_reads++;
    if (info_reads == 2 && !release_after_first_info) release_child();
  }
  int result = proc_pidinfo(pid, flavor, arg, buffer, buffersize);
  if (pid == target_pid && result == sizeof(struct proc_bsdinfo)) {
    const struct proc_bsdinfo *info = buffer;
    if (info_reads == 1) {
      first_status = info->pbi_status;
      if (release_after_first_info) release_child();
    } else if (info_reads == 2) second_status = info->pbi_status;
  }
  return result;
}

int main(int argc, char **argv) {
  if (argc == 5 && !strcmp(argv[1], "--child")) {
    int release = atoi(argv[2]), ready = atoi(argv[3]);
    char byte = 'r';
    if (write(ready, &byte, 1) != 1) return 70;
    close(ready);
    if (read(release, &byte, 1) != 1 || setpgid(0, 0) != 0) return 70;
    if (!strcmp(argv[4], "stop") && raise(SIGSTOP) != 0) return 70;
    return 0;
  }
  if (argc != 3) return 64;
  int control = -1;
  for (size_t index = 0; index < sizeof(control_names) / sizeof(control_names[0]); index++) {
    if (!strcmp(argv[2], control_names[index])) control = (int)index;
  }
  if (control < 0) return 64;
  if (signal(SIGALRM, contain_on_signal) == SIG_ERR ||
      signal(SIGTERM, contain_on_signal) == SIG_ERR ||
      signal(SIGINT, contain_on_signal) == SIG_ERR) return 70;
  alarm(5);
  release_after_first_info = control == CONTROL_ENVIRONMENT;
  deny_catalogue = control == CONTROL_SELECTED_CATALOGUE || control == CONTROL_SNAPSHOT_CATALOGUE;
  int release[2], ready[2];
  if (pipe(release) != 0 || pipe(ready) != 0) return 70;
  target_pid = fork();
  if (target_pid < 0) return 70;
  if (target_pid == 0) {
    char release_number[32], ready_number[32];
    close(release[1]);
    close(ready[0]);
    snprintf(release_number, sizeof(release_number), "%d", release[0]);
    snprintf(ready_number, sizeof(ready_number), "%d", ready[1]);
    if ((control == CONTROL_SELECTED_INSPECTOR || control == CONTROL_SNAPSHOT_INSPECTOR) &&
        setenv("MAISTER_TEST_PROCESS_INSPECTOR", argv[1], 1) != 0) _exit(70);
    execl(argv[0], argv[0], "--child", release_number, ready_number, release_after_first_info ? "exit" : "stop", NULL);
    _exit(70);
  }
  if (atexit(contain_child) != 0) {
    contain_child();
    return 70;
  }
  close(release[0]);
  close(ready[1]);
  release_fd = release[1];
  char byte;
  if (read(ready[0], &byte, 1) != 1) return 70;
  close(ready[0]);
  char pid_number[32];
  snprintf(pid_number, sizeof(pid_number), "%d", target_pid);
  char *reader_args[] = {argv[0], argv[1], pid_number, NULL};
  int snapshot = control == CONTROL_ENVIRONMENT || control == CONTROL_SNAPSHOT_CATALOGUE || control == CONTROL_SNAPSHOT_INSPECTOR;
  int result = native_reader_main(snapshot ? 2 : 3, reader_args);
  fprintf(stderr, "{\"event\":\"native-transition-control\",\"pid\":%d,\"infoReads\":%u,\"firstStatus\":%u,\"secondStatus\":%u,\"catalogueCalls\":%u,\"catalogueDenied\":%d}\n", target_pid, info_reads, first_status, second_status, catalogue_calls, deny_catalogue);
  if (!child_released) release_child();
  close(release_fd);
  if (!release_after_first_info && kill(target_pid, SIGCONT) != 0) return 70;
  int outcome;
  if (waitpid(target_pid, &outcome, 0) != target_pid) return 70;
  target_pid = 0;
  if (!WIFEXITED(outcome) || WEXITSTATUS(outcome) != 0) return 70;
  return result;
}
