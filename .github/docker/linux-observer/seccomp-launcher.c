#include <errno.h>
#include <linux/sched.h>
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <unistd.h>

#ifndef __NR_clone3
#if defined(__x86_64__)
#define __NR_clone3 435
#elif defined(__aarch64__)
#define __NR_clone3 435
#endif
#endif

static void must(int rc, const char *message) {
  if (rc < 0) {
    perror(message);
    _exit(126);
  }
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: awb-seccomp-launcher <program> [args...]\n");
    return 126;
  }

  must(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "prctl(PR_SET_NO_NEW_PRIVS)");

  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  if (ctx == NULL) {
    fprintf(stderr, "seccomp_init failed\n");
    return 126;
  }

  must(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(fork), 0), "seccomp fork");
  must(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(vfork), 0), "seccomp vfork");
  must(
      seccomp_rule_add(
          ctx,
          SCMP_ACT_ERRNO(EPERM),
          SCMP_SYS(clone),
          1,
          SCMP_A0(SCMP_CMP_MASKED_EQ, CLONE_THREAD, 0)),
      "seccomp clone without CLONE_THREAD");
#ifdef __NR_clone3
  /*
   * clone3 stores flags behind a pointer, which classic seccomp BPF cannot
   * inspect. Report ENOSYS so libc falls back to clone; the rule above then
   * permits only thread creation and rejects child-process creation.
   */
  must(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), __NR_clone3, 0), "seccomp clone3");
#endif

  must(seccomp_load(ctx), "seccomp_load");
  seccomp_release(ctx);

  execvp(argv[1], &argv[1]);
  perror("execvp");
  return 126;
}
