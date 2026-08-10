## about ODP and HTTP serving

this one isn't obvious right away, if we simply let users connect with their regular passwords to these unsafe protocols, they can put in jeopardy their password.

same thing will happen to an API key, plus it's hard to type a long API key into these small devices...

one way to solve this: one use generated passwords. users can go to the "Connect an old device" page and this is where the fun begins: they can generate a one off password here, it's short in every sense of the term: the user _must_ start this subsystem first before using it, it generates a one use password easy to use, it expires automatically after 10 minutes (and the subsystem shuts itself down).

their JWT token can still leak tho... we need either a strict time limit for their session, or, a machine ID (the last one is out of the equation...)
